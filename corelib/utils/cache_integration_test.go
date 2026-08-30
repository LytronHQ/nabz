package utils

import (
	"context"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"monitors/corelib/models"
)

// TestCacheScheduling exercises the sorted-set scheduling ops against a real
// Valkey. It is skipped unless VALKEY_ADDR (host:port) is set, so the normal
// `go test ./...` stays hermetic. Run with:
//
//	VALKEY_ADDR=localhost:6399 go test ./corelib/utils -run TestCacheScheduling -v
func TestCacheScheduling(t *testing.T) {
	addr := os.Getenv("VALKEY_ADDR")
	if addr == "" {
		t.Skip("set VALKEY_ADDR to run the Valkey integration test")
	}
	host, portStr, ok := strings.Cut(addr, ":")
	if !ok {
		t.Fatalf("VALKEY_ADDR must be host:port, got %q", addr)
	}
	port, err := strconv.Atoi(portStr)
	if err != nil {
		t.Fatalf("invalid port in VALKEY_ADDR: %s", err)
	}

	ctx := context.Background()
	config := models.Config{Cache: cacheConfig(host, port)}

	cache, err := GetCacheClient(ctx, config)
	if err != nil {
		t.Fatalf("connect: %s", err)
	}
	defer cache.Client.Close()

	if err := cache.Ping(ctx); err != nil {
		t.Fatalf("ping: %s", err)
	}

	key := "due:test-" + portStr
	cache.Client.Do(ctx, cache.Client.B().Del().Key(key).Build())

	// ScheduleNX inserts; a second NX must NOT overwrite the score.
	if err := cache.ScheduleNX(ctx, key, "m1", 100); err != nil {
		t.Fatalf("ScheduleNX: %s", err)
	}
	if err := cache.ScheduleNX(ctx, key, "m1", 999); err != nil {
		t.Fatalf("ScheduleNX (second): %s", err)
	}

	// reserve pushes a claimed member far into the future so it won't be handed
	// out again within this test's score range.
	const reserve = 1e12

	// Nothing is due at maxScore=50 (m1 is at 100).
	if _, _, found, err := cache.ReserveDue(ctx, key, 50, reserve); err != nil || found {
		t.Fatalf("ReserveDue(50) expected none, got found=%v err=%v", found, err)
	}

	// m1 is due at maxScore=150, and its original score must still be 100 (NX held).
	member, score, found, err := cache.ReserveDue(ctx, key, 150, reserve)
	if err != nil || !found {
		t.Fatalf("ReserveDue(150) expected m1, got found=%v err=%v", found, err)
	}
	if member != "m1" || score != 100 {
		t.Fatalf("ReserveDue(150) = (%q,%v), want (m1,100)", member, score)
	}

	// The reservation held it — it is no longer due.
	if _, _, found, err := cache.ReserveDue(ctx, key, 150, reserve); err != nil || found {
		t.Fatalf("ReserveDue after reserve expected none, got found=%v err=%v", found, err)
	}

	// Past the reservation time it is due again — i.e. a crashed worker's job is
	// redelivered once the reservation lapses.
	if m, _, found, _ := cache.ReserveDue(ctx, key, 2e12, reserve); !found || m != "m1" {
		t.Fatalf("expected m1 redelivered past reservation, got found=%v m=%q", found, m)
	}

	// Schedule (upsert) two members; ReserveDue must return the lowest score first.
	if err := cache.Schedule(ctx, key, "m2", 200); err != nil {
		t.Fatalf("Schedule m2: %s", err)
	}
	if err := cache.Schedule(ctx, key, "m3", 100); err != nil {
		t.Fatalf("Schedule m3: %s", err)
	}
	if member, _, _, _ := cache.ReserveDue(ctx, key, 1000, reserve); member != "m3" {
		t.Fatalf("expected lowest-score m3 first, got %q", member)
	}
	if member, _, _, _ := cache.ReserveDue(ctx, key, 1000, reserve); member != "m2" {
		t.Fatalf("expected m2 second, got %q", member)
	}

	// Remove works and leaves nothing due.
	cache.Schedule(ctx, key, "m4", 50)
	if err := cache.Remove(ctx, key, "m4"); err != nil {
		t.Fatalf("Remove: %s", err)
	}
	if _, _, found, _ := cache.ReserveDue(ctx, key, 1000, reserve); found {
		t.Fatalf("expected nothing due after Remove")
	}

	// Zcard + EarliestScore (dashboard queue depth + schedule lag inputs).
	statsKey := key + "-stats"
	cache.Client.Do(ctx, cache.Client.B().Del().Key(statsKey).Build())

	if depth, err := cache.Zcard(ctx, statsKey); err != nil || depth != 0 {
		t.Fatalf("Zcard empty = (%d,%v), want (0,nil)", depth, err)
	}
	if _, found, err := cache.EarliestScore(ctx, statsKey); err != nil || found {
		t.Fatalf("EarliestScore empty expected none, got found=%v err=%v", found, err)
	}

	cache.Schedule(ctx, statsKey, "a", 300)
	cache.Schedule(ctx, statsKey, "b", 100)
	cache.Schedule(ctx, statsKey, "c", 200)

	if depth, err := cache.Zcard(ctx, statsKey); err != nil || depth != 3 {
		t.Fatalf("Zcard = (%d,%v), want (3,nil)", depth, err)
	}
	earliest, found, err := cache.EarliestScore(ctx, statsKey)
	if err != nil || !found || earliest != 100 {
		t.Fatalf("EarliestScore = (%v,%v,%v), want (100,true,nil)", earliest, found, err)
	}

	cache.Client.Do(ctx, cache.Client.B().Del().Key(statsKey).Build())
	cache.Client.Do(ctx, cache.Client.B().Del().Key(key).Build())
}

// cacheConfig builds the anonymous Cache struct models.Config declares inline.
// Spelling the literal out at every call site means adding one field breaks each
// of them; this keeps that blast radius at one line.
func cacheConfig(host string, port int) *struct {
	Host     string `yaml:"host"`
	Port     int    `yaml:"port"`
	Password string `yaml:"password"`
} {
	return &struct {
		Host     string `yaml:"host"`
		Port     int    `yaml:"port"`
		Password string `yaml:"password"`
	}{Host: host, Port: port}
}

// TestLeaderLockAndHeartbeat exercises the multi-worker-per-zone primitives
// (#311) against a real Valkey: only one holder at a time, the holder can renew
// without losing it, a stale holder's lock frees up, and the heartbeat set
// counts live workers and prunes dead ones.
//
// Same VALKEY_ADDR gate as above, so `go test ./...` stays hermetic.
func TestLeaderLockAndHeartbeat(t *testing.T) {
	addr := os.Getenv("VALKEY_ADDR")
	if addr == "" {
		t.Skip("set VALKEY_ADDR to run the Valkey integration test")
	}
	host, portStr, ok := strings.Cut(addr, ":")
	if !ok {
		t.Fatalf("VALKEY_ADDR must be host:port, got %q", addr)
	}
	port, err := strconv.Atoi(portStr)
	if err != nil {
		t.Fatalf("invalid port in VALKEY_ADDR: %s", err)
	}

	ctx := context.Background()
	cache, err := GetCacheClient(ctx, models.Config{Cache: cacheConfig(host, port)})
	if err != nil {
		t.Fatalf("connect: %s", err)
	}

	lockKey := "test:seed:lock:" + strconv.FormatInt(time.Now().UnixNano(), 10)
	hbKey := "test:workers:" + strconv.FormatInt(time.Now().UnixNano(), 10)
	t.Cleanup(func() {
		_ = cache.ReleaseLock(ctx, lockKey, "a")
		_ = cache.ReleaseLock(ctx, lockKey, "b")
		_ = cache.Client.Do(ctx, cache.Client.B().Del().Key(hbKey).Build()).Error()
	})

	// One holder wins; the rival is refused rather than sharing it.
	if got, err := cache.AcquireLock(ctx, lockKey, "a", 2*time.Second); err != nil || !got {
		t.Fatalf("a should take a free lock: got=%v err=%v", got, err)
	}
	if got, err := cache.AcquireLock(ctx, lockKey, "b", 2*time.Second); err != nil || got {
		t.Fatalf("b must not take a held lock: got=%v err=%v", got, err)
	}

	// The holder renews. A plain SET NX would fail here and hand the zone to a
	// rival every TTL, so this is the case that actually keeps leadership stable.
	if got, err := cache.AcquireLock(ctx, lockKey, "a", 2*time.Second); err != nil || !got {
		t.Fatalf("a should renew its own lock: got=%v err=%v", got, err)
	}

	// Releasing is holder-checked: b must not be able to free a's lock, or two
	// seeders could run at once.
	if err := cache.ReleaseLock(ctx, lockKey, "b"); err != nil {
		t.Fatalf("release by non-holder: %s", err)
	}
	if got, _ := cache.AcquireLock(ctx, lockKey, "b", 2*time.Second); got {
		t.Fatal("b took the lock after releasing a lock it did not hold")
	}

	// Once the holder lets go, the zone fails over.
	if err := cache.ReleaseLock(ctx, lockKey, "a"); err != nil {
		t.Fatalf("release by holder: %s", err)
	}
	if got, err := cache.AcquireLock(ctx, lockKey, "b", 2*time.Second); err != nil || !got {
		t.Fatalf("b should take the freed lock: got=%v err=%v", got, err)
	}

	// Heartbeats: three live workers count as three, and the set is a set — the
	// same worker beating twice is still one worker.
	now := time.Now()
	for _, w := range []string{"w1", "w2", "w3", "w1"} {
		if err := cache.Heartbeat(ctx, hbKey, w, now, time.Minute); err != nil {
			t.Fatalf("heartbeat %s: %s", w, err)
		}
	}
	if n, err := cache.LiveWorkers(ctx, hbKey, now, time.Minute); err != nil || n != 3 {
		t.Fatalf("live workers = %d (err %v), want 3", n, err)
	}

	// A worker that stopped beating drops out: beat one of them into the past and
	// let the next heartbeat's prune sweep it.
	stale := now.Add(-5 * time.Minute)
	if err := cache.Heartbeat(ctx, hbKey, "w3", stale, time.Minute); err != nil {
		t.Fatalf("stale heartbeat: %s", err)
	}
	if err := cache.Heartbeat(ctx, hbKey, "w1", now, time.Minute); err != nil {
		t.Fatalf("prune heartbeat: %s", err)
	}
	if n, err := cache.LiveWorkers(ctx, hbKey, now, time.Minute); err != nil || n != 2 {
		t.Fatalf("live workers after a worker went away = %d (err %v), want 2", n, err)
	}
}
