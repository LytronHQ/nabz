// pbbench — measures PocketBase write/read capacity under nabz's real access
// pattern, through the normal HTTP API (worker service account for writes, a
// user for reads — same auth path and API rules as prod). Reports real numbers.
//
// Prereqs: a PocketBase instance with the nabz schema imported, a worker service
// account, a user, and >=1 monitor (see benchmarks/README.md). Nothing here
// writes to SQLite directly.
//
//	go run . -pb http://127.0.0.1:8090 -monitors monitors.txt \
//	  -wuser worker@bench.local -wpass workerpass123 \
//	  -ruser user@bench.local  -rpass userpass12345
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"math/rand"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

var (
	pbURL     = flag.String("pb", "http://127.0.0.1:8090", "PocketBase base URL")
	monsPath  = flag.String("monitors", "monitors.txt", "file of monitor ids, one per line")
	wUser     = flag.String("wuser", "worker@bench.local", "worker service-account identity")
	wPass     = flag.String("wpass", "workerpass123", "worker service-account password")
	rUser     = flag.String("ruser", "user@bench.local", "reader user identity")
	rPass     = flag.String("rpass", "userpass12345", "reader user password")
	levelDur  = flag.Duration("dur", 8*time.Second, "duration per ramp level / phase")
	seedRows  = flag.Int("seed", 250000, "checks to pre-seed, spread over 24h")
	batchSize = flag.Int("batch", 100, "batch size for seeding and Test C")
	runSeed   = flag.Bool("runseed", true, "pre-seed the checks table")
)

var zones = []string{"eu-central"}

func main() {
	flag.Parse()
	mons := loadLines(*monsPath)
	if len(mons) == 0 {
		fatal("no monitor ids in %s", *monsPath)
	}
	fmt.Printf("PB=%s  monitors=%d  levelDur=%s\n", *pbURL, len(mons), *levelDur)

	wTok := auth("service_accounts", *wUser, *wPass)
	rTok := auth("users", *rUser, *rPass)
	client := newClient()

	if *runSeed {
		seed(client, wTok, mons)
	}

	ceiling := testA(client, wTok, mons)
	testB(client, wTok, rTok, mons, ceiling)
	testC(client, wTok, mons, ceiling)
}

// ---------- Test A: single-insert write ceiling ----------

type levelStat struct {
	conc      int
	insPerSec float64
	p50, p99  float64
	errs      int64
}

func testA(client *http.Client, tok string, mons []string) (ceilingRate float64) {
	fmt.Printf("\n=== TEST A — single-insert write ceiling (POST /checks, worker SA) ===\n")
	fmt.Printf("%-6s %14s %9s %9s %7s\n", "conc", "inserts/s", "p50(ms)", "p99(ms)", "errs")
	levels := []int{1, 2, 4, 8, 16, 24, 32, 48, 64, 96, 128, 192, 256}
	var best levelStat
	for _, conc := range levels {
		st := runSingleWriters(client, tok, mons, conc, *levelDur)
		fmt.Printf("%-6d %14.0f %9.1f %9.1f %7d\n", st.conc, st.insPerSec, st.p50, st.p99, st.errs)
		if st.errs == 0 && st.p99 <= 500 && st.insPerSec > best.insPerSec {
			best = st
		}
		if st.p99 > 500 || st.errs > 0 {
			fmt.Printf("-> ceiling reached: p99 crossed 500ms (or errors) at conc=%d\n", conc)
			break
		}
	}
	fmt.Printf("-> sustained single-insert ceiling: %.0f inserts/s (conc=%d, p50=%.1fms p99=%.1fms)\n",
		best.insPerSec, best.conc, best.p50, best.p99)
	return best.insPerSec
}

func runSingleWriters(client *http.Client, tok string, mons []string, conc int, d time.Duration) levelStat {
	ctx, cancel := context.WithTimeout(context.Background(), d)
	defer cancel()
	var (
		wg   sync.WaitGroup
		mu   sync.Mutex
		lats []float64
		errs int64
	)
	start := time.Now()
	for i := 0; i < conc; i++ {
		wg.Add(1)
		go func(seed int) {
			defer wg.Done()
			rng := rand.New(rand.NewSource(int64(seed) + start.UnixNano()))
			local := make([]float64, 0, 4096)
			for ctx.Err() == nil {
				body := checkBody(mons[rng.Intn(len(mons))], zones[rng.Intn(len(zones))], time.Now())
				t0 := time.Now()
				code, err := post(client, "/api/collections/checks/records", tok, body)
				ms := float64(time.Since(t0).Microseconds()) / 1000
				if err != nil || (code != 200 && code != 201) {
					atomic.AddInt64(&errs, 1)
					continue
				}
				local = append(local, ms)
			}
			mu.Lock()
			lats = append(lats, local...)
			mu.Unlock()
		}(i)
	}
	wg.Wait()
	elapsed := time.Since(start).Seconds()
	sort.Float64s(lats)
	return levelStat{
		conc:      conc,
		insPerSec: float64(len(lats)) / elapsed,
		p50:       pct(lats, 50),
		p99:       pct(lats, 99),
		errs:      errs,
	}
}

// ---------- Test B: reads under write load ----------

func testB(client *http.Client, wTok, rTok string, mons []string, ceiling float64) {
	target := 0.6 * ceiling
	fmt.Printf("\n=== TEST B — reads under write load (writes held at 60%% ceiling = %.0f inserts/s) ===\n", target)

	ctx, cancel := context.WithTimeout(context.Background(), *levelDur*2)
	defer cancel()

	// rate-limited writers holding ~target inserts/s
	var writeCount int64
	stopWriters := rateLimitedWriters(ctx, client, wTok, mons, target, &writeCount)

	// readers: alternate a full dashboard load and a monitor-detail load
	var (
		wg              sync.WaitGroup
		mu              sync.Mutex
		dashLat, detLat []float64
	)
	readers := 4
	for i := 0; i < readers; i++ {
		wg.Add(1)
		go func(seed int) {
			defer wg.Done()
			rng := rand.New(rand.NewSource(int64(seed*7919) + 1))
			var dl, tl []float64
			for ctx.Err() == nil {
				dl = append(dl, dashboardLoad(client, rTok))
				if ctx.Err() != nil {
					break
				}
				tl = append(tl, detailLoad(client, rTok, mons[rng.Intn(len(mons))]))
			}
			mu.Lock()
			dashLat = append(dashLat, dl...)
			detLat = append(detLat, tl...)
			mu.Unlock()
		}(i)
	}
	wg.Wait()
	stopWriters()

	sort.Float64s(dashLat)
	sort.Float64s(detLat)
	fmt.Printf("%-22s %8s %9s %9s\n", "read page", "count", "p50(ms)", "p99(ms)")
	fmt.Printf("%-22s %8d %9.1f %9.1f\n", "dashboard (7 queries)", len(dashLat), pct(dashLat, 50), pct(dashLat, 99))
	fmt.Printf("%-22s %8d %9.1f %9.1f\n", "monitor detail (5/11)", len(detLat), pct(detLat, 50), pct(detLat, 99))
	fmt.Printf("-> writes sustained during read load: %.0f inserts/s\n", float64(atomic.LoadInt64(&writeCount))/(*levelDur*2).Seconds())
	if n := readFailures.Load(); n > 0 {
		// Loud, because the latency figures above are meaningless if reads were
		// being rejected: a 429 returns fast and would read as good news.
		fmt.Printf("!! %d read(s) returned non-2xx or failed — the latency above is NOT trustworthy\n", n)
	}
}

// dashboardLoad issues the exact queries app/src/routes/dashboard does, returning
// the total wall time for the page's data load.
func dashboardLoad(client *http.Client, tok string) float64 {
	now := time.Now()
	s90 := pbTime(now.Add(-90 * time.Minute))
	s24 := pbTime(now.Add(-24 * time.Hour))
	s60 := pbTime(now.Add(-60 * time.Second))
	t0 := time.Now()
	// getMonitorsOverview: monitors + one recent-checks pull
	get(client, tok, "monitors", "perPage=500&sort=name&filter="+q(`user!=""`))
	get(client, tok, "checks", "page=1&perPage=800&sort=-checked_at&fields=monitor,up,response_ms,checked_at&filter="+q(`checked_at >= "`+s90+`"`))
	// getFleetUptime24h: two counts
	get(client, tok, "checks", "page=1&perPage=1&filter="+q(`checked_at >= "`+s24+`"`))
	get(client, tok, "checks", "page=1&perPage=1&filter="+q(`checked_at >= "`+s24+`" && up=true`))
	// getChecksLastMinute
	get(client, tok, "checks", "page=1&perPage=1&filter="+q(`checked_at >= "`+s60+`"`))
	// getZoneStats + getOpenIncidents
	get(client, tok, "zone_stats", "perPage=50&sort=zone&fields=zone,updated")
	get(client, tok, "incidents", "perPage=20&sort=-started_at&expand=monitor&filter="+q(`resolved_at = ""`))
	return float64(time.Since(t0).Microseconds()) / 1000
}

// detailLoad issues FIVE of the monitor-detail page's eleven queries — the
// monitor row, the two 24h uptime counts, the recent-checks pull and the open
// incident. It deliberately omits the unbounded rollups and incident-history
// reads, so the figure it produces is a floor, not the page's real cost.
func detailLoad(client *http.Client, tok, mon string) float64 {
	now := time.Now()
	s24 := pbTime(now.Add(-24 * time.Hour))
	t0 := time.Now()
	get(client, tok, "monitors", "perPage=1&filter="+q(`id = "`+mon+`"`))
	// computeUptime24h: total + up counts for this monitor over 24h
	get(client, tok, "checks", "page=1&perPage=1&filter="+q(`monitor = "`+mon+`" && checked_at >= "`+s24+`"`))
	get(client, tok, "checks", "page=1&perPage=1&filter="+q(`monitor = "`+mon+`" && checked_at >= "`+s24+`" && up=true`))
	// fetchRecentChecks: recent checks for this monitor
	get(client, tok, "checks", "page=1&perPage=500&sort=-checked_at&filter="+q(`monitor = "`+mon+`" && checked_at >= "`+s24+`"`))
	// open incident for monitor
	get(client, tok, "incidents", "perPage=1&filter="+q(`monitor = "`+mon+`" && resolved_at = ""`))
	return float64(time.Since(t0).Microseconds()) / 1000
}

// ---------- Test C: batch inserts ----------

func testC(client *http.Client, tok string, mons []string, singleCeiling float64) {
	fmt.Printf("\n=== TEST C — batched inserts (/api/batch), sweeping batch size at conc=8 ===\n")
	fmt.Printf("%-8s %14s %9s %9s %7s\n", "batch", "inserts/s", "p50(ms)", "p99(ms)", "errs")
	var best levelStat
	var bestBatch int
	for _, bsize := range []int{1, 10, 50, 200, 500} {
		st := runBatchWriters(client, tok, mons, 8, bsize, *levelDur)
		fmt.Printf("%-8d %14.0f %9.1f %9.1f %7d\n", bsize, st.insPerSec, st.p50, st.p99, st.errs)
		if st.errs == 0 && st.insPerSec > best.insPerSec {
			best = st
			bestBatch = bsize
		}
	}
	fmt.Printf("-> batch ceiling: %.0f inserts/s (batch=%d, conc=8)\n", best.insPerSec, bestBatch)
	if singleCeiling > 0 {
		fmt.Printf("-> batch vs single ratio: %.2fx (%.0f / %.0f inserts/s)\n",
			best.insPerSec/singleCeiling, best.insPerSec, singleCeiling)
	}
}

func runBatchWriters(client *http.Client, tok string, mons []string, conc, bsize int, d time.Duration) levelStat {
	ctx, cancel := context.WithTimeout(context.Background(), d)
	defer cancel()
	var (
		wg    sync.WaitGroup
		mu    sync.Mutex
		lats  []float64
		count int64
		errs  int64
	)
	start := time.Now()
	for i := 0; i < conc; i++ {
		wg.Add(1)
		go func(seed int) {
			defer wg.Done()
			rng := rand.New(rand.NewSource(int64(seed) + start.UnixNano()))
			var local []float64
			for ctx.Err() == nil {
				body := batchBody(mons, rng, bsize, time.Now())
				t0 := time.Now()
				code, err := post(client, "/api/batch", tok, body)
				ms := float64(time.Since(t0).Microseconds()) / 1000
				if err != nil || code != 200 {
					atomic.AddInt64(&errs, 1)
					continue
				}
				local = append(local, ms)
				atomic.AddInt64(&count, int64(bsize))
			}
			mu.Lock()
			lats = append(lats, local...)
			mu.Unlock()
		}(i)
	}
	wg.Wait()
	elapsed := time.Since(start).Seconds()
	sort.Float64s(lats)
	return levelStat{conc: conc, insPerSec: float64(count) / elapsed, p50: pct(lats, 50), p99: pct(lats, 99), errs: errs}
}

// ---------- seeding ----------

func seed(client *http.Client, tok string, mons []string) {
	fmt.Printf("\nSeeding %d checks spread over 24h (batch=%d)...\n", *seedRows, *batchSize)
	start := time.Now()
	var count int64
	conc := 8
	var wg sync.WaitGroup
	per := *seedRows / conc
	for w := 0; w < conc; w++ {
		wg.Add(1)
		go func(seed int) {
			defer wg.Done()
			rng := rand.New(rand.NewSource(int64(seed) + 1))
			for done := 0; done < per; done += *batchSize {
				n := *batchSize
				if per-done < n {
					n = per - done
				}
				body := batchBodySpread(mons, rng, n)
				if code, err := post(client, "/api/batch", tok, body); err != nil || code != 200 {
					fatal("seed batch failed: code=%d err=%v", code, err)
				}
				atomic.AddInt64(&count, int64(n))
			}
		}(w)
	}
	wg.Wait()
	fmt.Printf("seeded %d rows in %s (%.0f rows/s via batch)\n", count, time.Since(start).Truncate(time.Millisecond), float64(count)/time.Since(start).Seconds())
}

// ---------- helpers ----------

func checkBody(mon, zone string, at time.Time) []byte {
	b, _ := json.Marshal(map[string]any{
		"monitor": mon, "zone": zone, "up": true, "status_code": 200,
		"response_ms": 120, "dns_ms": 10, "connect_ms": 20, "tls_ms": 30, "ttfb_ms": 60,
		"error": "", "redirect_count": 0, "final_url": "", "checked_at": at.UTC().Format(time.RFC3339),
	})
	return b
}

func batchBody(mons []string, rng *rand.Rand, n int, at time.Time) []byte {
	reqs := make([]map[string]any, n)
	for i := 0; i < n; i++ {
		reqs[i] = map[string]any{"method": "POST", "url": "/api/collections/checks/records",
			"body": json.RawMessage(checkBody(mons[rng.Intn(len(mons))], zones[rng.Intn(len(zones))], at))}
	}
	b, _ := json.Marshal(map[string]any{"requests": reqs})
	return b
}

func batchBodySpread(mons []string, rng *rand.Rand, n int) []byte {
	reqs := make([]map[string]any, n)
	for i := 0; i < n; i++ {
		at := time.Now().Add(-time.Duration(rng.Int63n(int64(24 * time.Hour))))
		reqs[i] = map[string]any{"method": "POST", "url": "/api/collections/checks/records",
			"body": json.RawMessage(checkBody(mons[rng.Intn(len(mons))], zones[rng.Intn(len(zones))], at))}
	}
	b, _ := json.Marshal(map[string]any{"requests": reqs})
	return b
}

// rateLimitedWriters spawns writers that collectively hold ~rate inserts/s via a
// token ticker. Returns a stop func.
func rateLimitedWriters(ctx context.Context, client *http.Client, tok string, mons []string, rate float64, count *int64) func() {
	if rate < 1 {
		rate = 1
	}
	interval := time.Duration(float64(time.Second) / rate)
	tick := time.NewTicker(interval)
	workers := 32
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(seed int) {
			defer wg.Done()
			rng := rand.New(rand.NewSource(int64(seed) + 99))
			for {
				select {
				case <-ctx.Done():
					return
				case <-tick.C:
					body := checkBody(mons[rng.Intn(len(mons))], zones[rng.Intn(len(zones))], time.Now())
					if code, err := post(client, "/api/collections/checks/records", tok, body); err == nil && (code == 200 || code == 201) {
						atomic.AddInt64(count, 1)
					}
				}
			}
		}(i)
	}
	return func() { tick.Stop(); wg.Wait() }
}

func newClient() *http.Client {
	return &http.Client{
		Timeout: 30 * time.Second,
		Transport: &http.Transport{
			MaxIdleConns:        512,
			MaxIdleConnsPerHost: 512,
			MaxConnsPerHost:     512,
			IdleConnTimeout:     60 * time.Second,
		},
	}
}

func auth(collection, identity, password string) string {
	b, _ := json.Marshal(map[string]string{"identity": identity, "password": password})
	req, _ := http.NewRequest("POST", *pbURL+"/api/collections/"+collection+"/auth-with-password", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		fatal("auth %s: %v", collection, err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		fatal("auth %s: status %d", collection, res.StatusCode)
	}
	var out struct {
		Token string `json:"token"`
	}
	json.NewDecoder(res.Body).Decode(&out)
	if out.Token == "" {
		fatal("auth %s: empty token", collection)
	}
	return out.Token
}

func post(client *http.Client, path, tok string, body []byte) (int, error) {
	req, _ := http.NewRequest("POST", *pbURL+path, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", tok)
	res, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	drain(res)
	return res.StatusCode, nil
}

// readFailures counts reads that did not return 2xx, or failed outright. A run
// against an instance that starts rate-limiting or 401ing would otherwise report
// the rejections as fast successes — optimistic latency instead of a failure.
var readFailures atomic.Int64

func get(client *http.Client, tok, collection, query string) {
	req, _ := http.NewRequest("GET", *pbURL+"/api/collections/"+collection+"/records?"+query, nil)
	req.Header.Set("Authorization", tok)
	res, err := client.Do(req)
	if err != nil {
		readFailures.Add(1)
		return
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		readFailures.Add(1)
	}
	drain(res)
}

func drain(res *http.Response) {
	var b [4096]byte
	for {
		if _, err := res.Body.Read(b[:]); err != nil {
			break
		}
	}
	res.Body.Close()
}

func q(s string) string { return url.QueryEscape(s) }

func pbTime(t time.Time) string { return t.UTC().Format("2006-01-02 15:04:05.000Z") }

func pct(sorted []float64, p float64) float64 {
	if len(sorted) == 0 {
		return 0
	}
	i := int(p / 100 * float64(len(sorted)))
	if i >= len(sorted) {
		i = len(sorted) - 1
	}
	return sorted[i]
}

func loadLines(path string) []string {
	data, err := os.ReadFile(path)
	if err != nil {
		fatal("read %s: %v", path, err)
	}
	var out []string
	for _, l := range strings.Split(string(data), "\n") {
		if l = strings.TrimSpace(l); l != "" {
			out = append(out, l)
		}
	}
	return out
}

func fatal(f string, a ...any) { fmt.Fprintf(os.Stderr, "FATAL: "+f+"\n", a...); os.Exit(1) }
