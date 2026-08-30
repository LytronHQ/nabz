package utils

import (
	"context"
	"fmt"
	"log"
	"strconv"
	"time"

	"monitors/corelib/models"

	valkey "github.com/valkey-io/valkey-go"
)

// reserveDueScript atomically reserves the single lowest-scored member whose
// score is due (<= now): it bumps that member's score to a future reservation
// time (ARGV[2]) and returns the member with its ORIGINAL score. Reserving
// (instead of removing) means a worker that crashes mid-check does not lose the
// job — the reservation lapses and the monitor becomes due again. On a
// successful check the worker overwrites the reservation with the next real
// due time. ZPOPMIN can't do any of this (it ignores the due cutoff).
const reserveDueScript = `
local due = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'WITHSCORES', 'LIMIT', 0, 1)
if #due == 0 then
  return nil
end
redis.call('ZADD', KEYS[1], ARGV[2], due[1])
return due
`

type CacheClient struct {
	valkey.Client
}

func NewCacheClient(client valkey.Client) *CacheClient {
	return &CacheClient{client}
}

// GetCacheClient connects to Valkey. It returns an error instead of fatally
// exiting so callers can decide how to handle a connection failure.
func GetCacheClient(ctx context.Context, config models.Config) (*CacheClient, error) {
	if config.Cache == nil {
		return nil, fmt.Errorf("cache config is missing")
	}
	address := fmt.Sprintf("%s:%d", config.Cache.Host, config.Cache.Port)
	client, err := valkey.NewClient(valkey.ClientOption{
		InitAddress: []string{address},
		// Empty means no AUTH, which is the per-node sidecar. A shared zone
		// Valkey (#311) is reachable over the private network and sets it.
		Password: config.Cache.Password,
	})
	if err != nil {
		return nil, fmt.Errorf("connecting to Valkey at %s: %w", address, err)
	}
	return NewCacheClient(client), nil
}

// ConnectCacheWithRetry connects to Valkey (and verifies it with a ping),
// retrying with exponential backoff + jitter until it succeeds — so a briefly
// unavailable Valkey at startup becomes an in-process wait instead of a tight
// Docker restart loop. It blocks until connected.
func ConnectCacheWithRetry(ctx context.Context, config models.Config) *CacheClient {
	for attempt := 1; ; attempt++ {
		cache, err := GetCacheClient(ctx, config)
		if err == nil {
			if err = cache.Ping(ctx); err == nil {
				if attempt > 1 {
					log.Printf("Valkey: connected after %d attempts", attempt)
				}
				return cache
			}
			cache.Client.Close() // ping failed — close before retrying
		}
		delay := Jitter(Backoff(attempt, RetryBaseDelay, RetryMaxDelay))
		log.Printf("Valkey: connect attempt %d failed (%s) — retrying in %s", attempt, err, delay.Truncate(time.Millisecond))
		time.Sleep(delay)
	}
}

// Ping verifies connectivity to Valkey.
func (cc *CacheClient) Ping(ctx context.Context) error {
	return cc.Client.Do(ctx, cc.Client.B().Ping().Build()).Error()
}

// ScheduleNX adds a member to the due sorted set with the given score only if it
// is not already present (ZADD NX). Used by the seeder so it never disturbs an
// already-scheduled monitor.
func (cc *CacheClient) ScheduleNX(ctx context.Context, key, member string, score float64) error {
	cmd := cc.Client.B().Zadd().Key(key).Nx().ScoreMember().ScoreMember(score, member).Build()
	return cc.Client.Do(ctx, cmd).Error()
}

// Schedule sets a member's score in the due sorted set (ZADD, upsert). Used when
// rescheduling the next check after one completes.
func (cc *CacheClient) Schedule(ctx context.Context, key, member string, score float64) error {
	cmd := cc.Client.B().Zadd().Key(key).ScoreMember().ScoreMember(score, member).Build()
	return cc.Client.Do(ctx, cmd).Error()
}

// Remove deletes a member from the due sorted set (ZREM).
func (cc *CacheClient) Remove(ctx context.Context, key, member string) error {
	return cc.Client.Do(ctx, cc.Client.B().Zrem().Key(key).Member(member).Build()).Error()
}

// Zcard returns the number of members in the sorted set (queue depth).
func (cc *CacheClient) Zcard(ctx context.Context, key string) (int64, error) {
	return cc.Client.Do(ctx, cc.Client.B().Zcard().Key(key).Build()).AsInt64()
}

// EarliestScore returns the lowest score in the sorted set. found is false when
// the set is empty.
func (cc *CacheClient) EarliestScore(ctx context.Context, key string) (score float64, found bool, err error) {
	cmd := cc.Client.B().Zrange().Key(key).Min("0").Max("0").Withscores().Build()
	scores, err := cc.Client.Do(ctx, cmd).AsZScores()
	if err != nil {
		return 0, false, err
	}
	if len(scores) == 0 {
		return 0, false, nil
	}
	return scores[0].Score, true, nil
}

// ReserveDue atomically reserves the earliest-due member with score <= maxScore,
// bumping its score to reserveScore, and returns its original score. found is
// false when nothing is due.
func (cc *CacheClient) ReserveDue(ctx context.Context, key string, maxScore, reserveScore float64) (member string, score float64, found bool, err error) {
	maxScoreStr := strconv.FormatFloat(maxScore, 'f', -1, 64)
	reserveScoreStr := strconv.FormatFloat(reserveScore, 'f', -1, 64)
	cmd := cc.Client.B().Eval().Script(reserveDueScript).Numkeys(1).Key(key).Arg(maxScoreStr).Arg(reserveScoreStr).Build()
	result := cc.Client.Do(ctx, cmd)

	if err = result.Error(); err != nil {
		if valkey.IsValkeyNil(err) {
			return "", 0, false, nil
		}
		return "", 0, false, err
	}

	arr, err := result.ToArray()
	if err != nil {
		return "", 0, false, err
	}
	if len(arr) < 2 {
		return "", 0, false, nil
	}

	member, err = arr[0].ToString()
	if err != nil {
		return "", 0, false, err
	}
	scoreStr, err := arr[1].ToString()
	if err != nil {
		return "", 0, false, err
	}
	score, err = strconv.ParseFloat(scoreStr, 64)
	if err != nil {
		return "", 0, false, err
	}
	return member, score, true, nil
}

// AcquireLock takes a lock for ttl, or renews it if this holder already has it.
// Returns whether the caller holds it afterwards.
//
// Used to elect one seeder per zone (#311). With N workers in a zone every one of
// them would otherwise run seedLoop, doing the same PocketBase scan N times over.
// It is an optimisation, not a correctness mechanism: ScheduleNX means a brief
// overlap during failover just re-adds members that are already scheduled.
func (cc *CacheClient) AcquireLock(ctx context.Context, key, holder string, ttl time.Duration) (bool, error) {
	ms := ttl.Milliseconds()
	// SET NX takes it when free. If we already hold it, extend — a plain NX would
	// fail for the current holder and hand the lock to a rival every TTL.
	ok, err := cc.Client.Do(ctx,
		cc.Client.B().Set().Key(key).Value(holder).Nx().PxMilliseconds(ms).Build()).AsBool()
	if err == nil && ok {
		return true, nil
	}
	cur, err := cc.Client.Do(ctx, cc.Client.B().Get().Key(key).Build()).ToString()
	if err != nil || cur != holder {
		return false, nil
	}
	if err := cc.Client.Do(ctx,
		cc.Client.B().Pexpire().Key(key).Milliseconds(ms).Build()).Error(); err != nil {
		return false, err
	}
	return true, nil
}

// ReleaseLock drops the lock, but only if this holder still owns it — releasing
// someone else's lock after our own expired would let two seeders run at once.
func (cc *CacheClient) ReleaseLock(ctx context.Context, key, holder string) error {
	cur, err := cc.Client.Do(ctx, cc.Client.B().Get().Key(key).Build()).ToString()
	if err != nil || cur != holder {
		return nil
	}
	return cc.Client.Do(ctx, cc.Client.B().Del().Key(key).Build()).Error()
}

// Heartbeat records this worker as alive in its zone, scored by timestamp, and
// prunes anything older than ttl. The set's cardinality is then the live worker
// count for the zone (#311) — a count, deliberately, not a list of names: which
// container answered is ops detail, not something a user's dashboard needs.
func (cc *CacheClient) Heartbeat(ctx context.Context, key, worker string, now time.Time, ttl time.Duration) error {
	if err := cc.Client.Do(ctx, cc.Client.B().Zadd().Key(key).ScoreMember().
		ScoreMember(float64(now.Unix()), worker).Build()).Error(); err != nil {
		return err
	}
	cutoff := strconv.FormatInt(now.Add(-ttl).Unix(), 10)
	return cc.Client.Do(ctx,
		cc.Client.B().Zremrangebyscore().Key(key).Min("-inf").Max("("+cutoff).Build()).Error()
}

// LiveWorkers counts workers that have beaten within ttl.
func (cc *CacheClient) LiveWorkers(ctx context.Context, key string, now time.Time, ttl time.Duration) (int64, error) {
	min := strconv.FormatInt(now.Add(-ttl).Unix(), 10)
	return cc.Client.Do(ctx,
		cc.Client.B().Zcount().Key(key).Min(min).Max("+inf").Build()).AsInt64()
}
