package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"monitors/corelib/models"
	"monitors/corelib/pb"
)

// stubPB is a PocketBase that authenticates anyone and returns whatever monitor
// list the test asks for.
func stubPB(t *testing.T, monitorsBody string) *pb.Client {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "auth-with-password") {
			w.Write([]byte(`{"token":"tok"}`))
			return
		}
		w.Write([]byte(monitorsBody))
	}))
	t.Cleanup(srv.Close)

	var config models.Config
	config.PB = &struct {
		URL    string `yaml:"url"`
		Access struct {
			ClientId     string `yaml:"client_id"`
			ClientSecret string `yaml:"client_secret"`
		} `yaml:"access"`
		Admin struct {
			Collection string `yaml:"collection"`
			Username   string `yaml:"username"`
			Password   string `yaml:"password"`
			Token      string `yaml:"token"`
		} `yaml:"admin"`
	}{}
	config.PB.URL = srv.URL
	config.PB.Admin.Collection = "service_accounts"
	config.PB.Admin.Username = "worker@svc.local"
	config.PB.Admin.Password = "pw"

	c, err := pb.NewClient(config)
	if err != nil {
		t.Fatalf("stub client: %s", err)
	}
	return c
}

// The dangerous shape, and the reason this test exists.
//
// PocketBase applies a LIST rule as a filter: a request whose token has expired
// is treated as a guest, fails `@request.auth...`, and gets back HTTP 200 with an
// EMPTY list — not a 401. The client only re-authenticates on 401, so the refresh
// never fires and the worker is told, perfectly successfully, that the zone has
// no monitors.
//
// Reconcile must not answer that by unscheduling the entire zone. Nothing would
// error, zone_stats would keep being published with queue_depth 0, and the zone
// would look idle rather than broken — the worst way for a monitoring system to
// fail.
func TestReconcileWillNotEmptyTheScheduleOnAnEmptyList(t *testing.T) {
	sched := newSchedule()
	for _, id := range []string{"m1", "m2", "m3"} {
		sched.Add(id, 100)
	}
	mem := newMembership()

	reconcile(stubPB(t, `{"items":[]}`), sched, "eu", mem)

	if sched.Len() == 0 {
		t.Fatal("an empty monitor list unscheduled the whole zone — a stale token now stops all checking, silently")
	}
	if sched.Len() != 3 {
		t.Fatalf("schedule = %d monitors, want the 3 it had", sched.Len())
	}
}

// The guard must not stop a zone legitimately emptying: a worker with nothing
// scheduled yet, told there is nothing to schedule, is simply idle.
func TestReconcileAcceptsAnEmptyListWhenItHadNothing(t *testing.T) {
	sched := newSchedule()
	reconcile(stubPB(t, `{"items":[]}`), sched, "eu", newMembership())
	if sched.Len() != 0 {
		t.Fatalf("schedule = %d, want 0", sched.Len())
	}
}

// And it must not stop real pruning: a list that still has monitors is a list
// the worker can believe, so anything missing from it is genuinely gone.
func TestReconcileStillPrunesAgainstANonEmptyList(t *testing.T) {
	sched := newSchedule()
	for _, id := range []string{"keep", "gone1", "gone2"} {
		sched.Add(id, 100)
	}
	body := `{"items":[{"id":"keep","type":"website","interval":60,"enabled":true}]}`

	reconcile(stubPB(t, body), sched, "eu", newMembership())

	ids := sched.Ids()
	if len(ids) != 1 || ids[0] != "keep" {
		t.Fatalf("schedule = %v, want [keep] — a believable list must still prune", ids)
	}
}
