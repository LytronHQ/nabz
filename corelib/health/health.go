// Package health provides a two-tier HTTP health surface shared by the worker
// and evaluator nodes.
//
// The design rule is: report WHAT is broken (which node, which dependency, since
// when) — never WITH WHAT (addresses, ports, credentials, raw driver errors). To
// make that guarantee structural rather than incidental, dependency results are
// reduced to a fixed vocabulary of generic Labels; raw errors are discarded, not
// forwarded, so an address embedded in a driver error can never reach a response.
//
//   - PUBLIC (no auth): ok / degraded, plus — only on the aggregator — the names
//     of the unhealthy nodes. Nothing about internals.
//   - DEBUG (bearer token, constant-time compared): the same, plus each item's
//     generic dependency label, a static generic cause, and staleness duration.
//
// A missing or wrong token never leaks the debug body and never reveals whether a
// token is configured — it simply falls back to the public body.
package health

import (
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

// Build metadata, injected at link time via `-ldflags -X` (see the node
// dockerfiles). Empty under a plain `go build`, in which case it's omitted from
// responses. Exposed only on the debug tier — useful for triage, and not
// sensitive, but there's no reason to hand a version fingerprint to anonymous
// callers.
var (
	Version = ""
	Commit  = ""
)

// BuildString is a compact "v<version> (<commit>)" for startup logs; empty when
// no build metadata was injected.
func BuildString() string {
	switch {
	case Version != "" && Commit != "":
		return "v" + Version + " (" + Commit + ")"
	case Version != "":
		return "v" + Version
	case Commit != "":
		return Commit
	default:
		return ""
	}
}

// Status is the coarse public health state.
type Status string

const (
	StatusOK       Status = "ok"
	StatusDegraded Status = "degraded"
)

// Label is the ONLY vocabulary the debug tier exposes for a dependency or peer
// node. Raw driver errors are mapped to one of these and then discarded, so a
// response can never leak a host, port, or credential embedded in an error.
type Label string

const (
	LabelOK          Label = "ok"
	LabelUnreachable Label = "unreachable"
	LabelStale       Label = "stale"
	LabelStalled     Label = "stalled"
)

// cause returns a static, generic explanation for a label — WHAT is wrong, never
// WITH WHAT. The strings are constants, so they can't carry sensitive detail.
func cause(l Label) string {
	switch l {
	case LabelUnreachable:
		return "did not respond to a health probe"
	case LabelStale:
		return "no recent heartbeat within the staleness window"
	case LabelStalled:
		return "processing loop is not advancing"
	default:
		return ""
	}
}

// Item is one checked thing: a dependency (valkey, pocketbase) on a per-node
// report, or a peer node/zone on the aggregator.
type Item struct {
	Name     string
	Label    Label
	StaleFor time.Duration // 0 when not applicable
}

func (i Item) ok() bool { return i.Label == LabelOK }

// Report is the raw result of a health evaluation. It is projected differently
// per tier — never serialized directly — so the public body can't accidentally
// gain a field.
type Report struct {
	// Node is the reporting node's own name. Optional on the aggregator.
	Node  string
	Items []Item
}

func (r Report) status() Status {
	for _, it := range r.Items {
		if !it.ok() {
			return StatusDegraded
		}
	}
	return StatusOK
}

func (r Report) unhealthy() []string {
	var names []string
	for _, it := range r.Items {
		if !it.ok() {
			names = append(names, it.Name)
		}
	}
	return names
}

// Dependency is a named reachability probe. Check returns nil when healthy; any
// error is mapped to LabelUnreachable and the error itself is thrown away.
type Dependency struct {
	Name  string
	Check func() error
}

// evalDeps runs each probe and reduces it to a scrubbed Item.
func evalDeps(deps []Dependency) []Item {
	items := make([]Item, 0, len(deps))
	for _, d := range deps {
		label := LabelOK
		if d.Check() != nil {
			label = LabelUnreachable
		}
		items = append(items, Item{Name: d.Name, Label: label})
	}
	return items
}

// Server wires the HTTP health surface for a single node.
type Server struct {
	// Name of this node, e.g. "worker-eu" or "evaluator".
	Name string
	// Token gates the debug tier. Empty disables the debug body entirely.
	Token string
	// Deps are this node's own reachability probes, backing GET /health.
	Deps []Dependency
	// Aggregate, when non-nil, backs GET /health/all with a cross-node report
	// (the evaluator's view of every zone's heartbeat). Nil on the worker.
	Aggregate func() Report
}

// Handler builds the HTTP mux: always /health, plus /health/all when Aggregate
// is set.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		s.write(w, r, Report{Node: s.Name, Items: evalDeps(s.Deps)}, false)
	})
	if s.Aggregate != nil {
		mux.HandleFunc("/health/all", func(w http.ResponseWriter, r *http.Request) {
			s.write(w, r, s.Aggregate(), true)
		})
	}
	return mux
}

// Serve starts the health server on addr and blocks; callers run it in a
// goroutine. Read/write timeouts keep a slow client from tying up the node.
func (s *Server) Serve(addr string) error {
	srv := &http.Server{
		Addr:         addr,
		Handler:      s.Handler(),
		ReadTimeout:  5 * time.Second,
		WriteTimeout: 5 * time.Second,
	}
	return srv.ListenAndServe()
}

// authorized reports whether the request carries the configured debug token,
// compared in constant time. A blank configured token is never authorized.
func (s *Server) authorized(r *http.Request) bool {
	if s.Token == "" {
		return false
	}
	const prefix = "Bearer "
	h := r.Header.Get("Authorization")
	if !strings.HasPrefix(h, prefix) {
		return false
	}
	provided := strings.TrimPrefix(h, prefix)
	// ConstantTimeCompare returns 0 on any length mismatch, so it's safe to feed
	// attacker-controlled input directly.
	return subtle.ConstantTimeCompare([]byte(provided), []byte(s.Token)) == 1
}

func (s *Server) write(w http.ResponseWriter, r *http.Request, rep Report, aggregate bool) {
	w.Header().Set("Content-Type", "application/json")
	code := http.StatusOK
	if rep.status() == StatusDegraded {
		// 503 lets a plain HTTP monitor treat the node as down without parsing
		// the body.
		code = http.StatusServiceUnavailable
	}
	w.WriteHeader(code)

	var body any
	if s.authorized(r) {
		body = detailBody(rep, aggregate)
	} else {
		body = publicBody(rep, aggregate)
	}
	_ = json.NewEncoder(w).Encode(body)
}

// --- wire formats (kept private so only these fields can ever be emitted) ---

type publicResp struct {
	Status    Status   `json:"status"`
	Unhealthy []string `json:"unhealthy,omitempty"`
}

func publicBody(rep Report, aggregate bool) publicResp {
	resp := publicResp{Status: rep.status()}
	// Only the aggregator names nodes; a per-node public body never lists its own
	// dependencies (that would map internal architecture).
	if aggregate {
		resp.Unhealthy = rep.unhealthy()
	}
	return resp
}

type detailItem struct {
	Name     string `json:"name"`
	Status   Label  `json:"status"`
	Cause    string `json:"cause,omitempty"`
	StaleFor string `json:"stale_for,omitempty"`
}

type buildInfo struct {
	Version string `json:"version,omitempty"`
	Commit  string `json:"commit,omitempty"`
}

type detailResp struct {
	Status Status       `json:"status"`
	Node   string       `json:"node,omitempty"`
	Build  *buildInfo   `json:"build,omitempty"`
	Items  []detailItem `json:"items"`
}

func detailBody(rep Report, aggregate bool) detailResp {
	resp := detailResp{Status: rep.status(), Node: rep.Node, Items: make([]detailItem, 0, len(rep.Items))}
	if Version != "" || Commit != "" {
		resp.Build = &buildInfo{Version: Version, Commit: Commit}
	}
	for _, it := range rep.Items {
		di := detailItem{Name: it.Name, Status: it.Label, Cause: cause(it.Label)}
		if it.StaleFor > 0 {
			di.StaleFor = it.StaleFor.Truncate(time.Second).String()
		}
		resp.Items = append(resp.Items, di)
	}
	return resp
}
