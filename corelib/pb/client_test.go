package pb

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"monitors/corelib/models"
)

// paginatedServer serves `total` records across pages of listPageSize, so a
// caller that only reads the first page silently loses everything past it.
func paginatedServer(total int, reqs *int32) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(reqs, 1)
		page, _ := strconv.Atoi(r.URL.Query().Get("page"))
		start := (page - 1) * listPageSize
		n := 0
		if start < total {
			if n = listPageSize; start+n > total {
				n = total - start
			}
		}
		items := make([]map[string]string, n)
		for i := 0; i < n; i++ {
			items[i] = map[string]string{"id": strconv.Itoa(start + i)}
		}
		body, _ := json.Marshal(map[string]any{"items": items})
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(body)
	}))
}

// listAll must follow pages to completion — the bug behind the 500-monitor
// ceiling (#313) was a single-page read that truncated silently.
func TestListAllPaginatesToCompletion(t *testing.T) {
	cases := []struct {
		name           string
		total, wantReq int
	}{
		{"short single page", 200, 1},
		{"exact multiple of page size", listPageSize, 2}, // full page, then an empty one
		{"spans several pages", 2*listPageSize + 30, 3},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var reqs int32
			srv := paginatedServer(tc.total, &reqs)
			defer srv.Close()

			c := &Client{baseURL: srv.URL, token: "t"}
			got, err := listAll[map[string]string](c, "monitors", "skipTotal=true", "monitors", 0)
			if err != nil {
				t.Fatalf("listAll: %v", err)
			}
			if len(got) != tc.total {
				t.Fatalf("got %d records, want %d (pagination truncated?)", len(got), tc.total)
			}
			if int(reqs) != tc.wantReq {
				t.Fatalf("made %d page requests, want %d", reqs, tc.wantReq)
			}
		})
	}
}

// purgeStore is a tiny stateful record set for exercising PurgeOlderThan: list
// returns remaining ids, delete removes them, count reports the backlog.
type purgeStore struct {
	mu  sync.Mutex
	ids map[string]bool
}

func newPurgeStore(n int) *purgeStore {
	s := &purgeStore{ids: make(map[string]bool, n)}
	for i := 0; i < n; i++ {
		s.ids[strconv.Itoa(i)] = true
	}
	return s
}

func (s *purgeStore) list(limit int) []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]string, 0, limit)
	for id := range s.ids {
		if len(out) >= limit {
			break
		}
		out = append(out, id)
	}
	return out
}

func (s *purgeStore) del(id string) {
	s.mu.Lock()
	delete(s.ids, id)
	s.mu.Unlock()
}

func (s *purgeStore) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.ids)
}

func purgeServer(store *purgeStore) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete {
			parts := strings.Split(r.URL.Path, "/")
			store.del(parts[len(parts)-1])
			w.WriteHeader(http.StatusNoContent)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Query().Get("skipTotal") == "true" { // a purge list page
			perPage, _ := strconv.Atoi(r.URL.Query().Get("perPage"))
			ids := store.list(perPage)
			items := make([]map[string]string, len(ids))
			for i, id := range ids {
				items[i] = map[string]string{"id": id}
			}
			body, _ := json.Marshal(map[string]any{"items": items})
			_, _ = w.Write(body)
			return
		}
		// a count query (perPage=1, no skipTotal) -> totalItems
		body, _ := json.Marshal(map[string]any{"totalItems": store.count()})
		_, _ = w.Write(body)
	}))
}

// PurgeOlderThan must loop until the backlog is drained, not stop at one page —
// the old fixed 1000/run cap couldn't keep up with the insert rate (#314).
func TestPurgeOlderThanDrains(t *testing.T) {
	total := 2*listPageSize + 200 // spans three list pages
	store := newPurgeStore(total)
	srv := purgeServer(store)
	defer srv.Close()

	c := &Client{baseURL: srv.URL, token: "t"}
	r, err := c.PurgeOlderThan("checks", "checked_at", "", time.Now(), 30*time.Second)
	if err != nil {
		t.Fatalf("PurgeOlderThan: %v", err)
	}
	if r.Deleted != total {
		t.Fatalf("deleted %d, want %d (didn't drain?)", r.Deleted, total)
	}
	if r.Remaining != 0 {
		t.Fatalf("remaining %d, want 0 when drained", r.Remaining)
	}
	if store.count() != 0 {
		t.Fatalf("store still holds %d records", store.count())
	}
}

// When the time budget is spent before draining, it reports the remaining
// backlog — the signal that purge is falling behind.
func TestPurgeOlderThanReportsRemainingOnBudget(t *testing.T) {
	store := newPurgeStore(300)
	srv := purgeServer(store)
	defer srv.Close()

	c := &Client{baseURL: srv.URL, token: "t"}
	r, err := c.PurgeOlderThan("checks", "checked_at", "", time.Now(), -1) // no time to delete anything
	if err != nil {
		t.Fatalf("PurgeOlderThan: %v", err)
	}
	if r.Deleted != 0 {
		t.Fatalf("deleted %d, want 0 with no budget", r.Deleted)
	}
	if r.Remaining != 300 {
		t.Fatalf("remaining %d, want 300", r.Remaining)
	}
}

// GetChecksSince feeds the hourly rollup; it must paginate, or a high-frequency
// monitor's rollup is silently undercounted — permanently, since rollups outlive
// the raw checks (#315).
func TestGetChecksSincePaginates(t *testing.T) {
	total := listPageSize + 250 // more than one page
	var reqs int32
	srv := paginatedServer(total, &reqs)
	defer srv.Close()

	c := &Client{baseURL: srv.URL, token: "t"}
	got, err := c.GetChecksSince("mon1", time.Now().Add(-time.Hour))
	if err != nil {
		t.Fatalf("GetChecksSince: %v", err)
	}
	if len(got) != total {
		t.Fatalf("got %d checks, want %d (truncated at one page?)", len(got), total)
	}
	if reqs < 2 {
		t.Fatalf("made %d requests, expected pagination (>=2)", reqs)
	}
}

// The service-account cutover (#70): NewClient must NOT fall back to _superusers
// when the auth collection is unset. It returns an error before any network call,
// so a misconfigured node fails loudly instead of running with superuser rights.
func TestNewClientRejectsEmptyAuthCollection(t *testing.T) {
	var config models.Config
	config.PB = &struct {
		URL   string `yaml:"url"`
		Admin struct {
			Collection string `yaml:"collection"`
			Username   string `yaml:"username"`
			Password   string `yaml:"password"`
			Token      string `yaml:"token"`
		} `yaml:"admin"`
	}{}
	config.PB.URL = "http://127.0.0.1:1" // never dialled: the guard returns first
	config.PB.Admin.Collection = ""
	config.PB.Admin.Username = "someone@svc.local"
	config.PB.Admin.Password = "pw"

	_, err := NewClient(config)
	if err == nil {
		t.Fatal("NewClient with empty auth collection should error, not fall back to _superusers")
	}
	if !strings.Contains(err.Error(), "auth collection is not set") {
		t.Fatalf("unexpected error: %v", err)
	}
}
