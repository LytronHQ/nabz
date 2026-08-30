package main

import (
	"testing"

	"monitors/corelib/models"
	"monitors/corelib/utils"
)

func TestChannelsThroughLevel(t *testing.T) {
	ch := func(id string) models.AlertChannel { return models.AlertChannel{Id: id} }
	ids := func(chans []models.AlertChannel) []string {
		out := make([]string, 0, len(chans))
		for _, c := range chans {
			out = append(out, c.Id)
		}
		return out
	}
	eq := func(a, b []string) bool {
		if len(a) != len(b) {
			return false
		}
		for i := range a {
			if a[i] != b[i] {
				return false
			}
		}
		return true
	}

	single := []resolvedLevel{{Channels: []models.AlertChannel{ch("a"), ch("b")}}}
	multi := []resolvedLevel{
		{Channels: []models.AlertChannel{ch("a")}},
		{Channels: []models.AlertChannel{ch("b"), ch("c")}},
	}
	overlap := []resolvedLevel{
		{Channels: []models.AlertChannel{ch("a"), ch("b")}},
		{Channels: []models.AlertChannel{ch("b"), ch("c")}},
	}

	cases := []struct {
		name   string
		levels []resolvedLevel
		level  int
		want   []string
	}{
		// No-policy / single level: recovery still reaches everyone (unchanged).
		{"single level, fired 1", single, 1, []string{"a", "b"}},
		// escalation_level 0 (never recorded) clamps to level 0.
		{"clamp below to level 0", single, 0, []string{"a", "b"}},
		// Multi-level, recovered before escalating: only level 0 was paged.
		{"multi, only L0 fired", multi, 1, []string{"a"}},
		// Multi-level, escalated: both levels' channels.
		{"multi, both fired", multi, 2, []string{"a", "b", "c"}},
		// De-dupe channels shared across levels.
		{"dedupe across levels", overlap, 2, []string{"a", "b", "c"}},
		// Clamp above len(levels).
		{"clamp above len", multi, 5, []string{"a", "b", "c"}},
		{"no levels", nil, 1, nil},
	}
	for _, c := range cases {
		got := ids(channelsThroughLevel(c.levels, c.level))
		if !eq(got, c.want) {
			t.Errorf("%s: channelsThroughLevel = %v, want %v", c.name, got, c.want)
		}
	}
}

func TestHTTPErrDetail(t *testing.T) {
	cases := []struct {
		name     string
		provider string
		body     string
		code     int
		want     string
	}{
		// Telegram puts the reason in "description" — this is the "chat not found"
		// case that a bare status code hid.
		{"telegram description", "telegram", `{"ok":false,"error_code":400,"description":"Bad Request: chat not found"}`, 400, "telegram returned status 400: Bad Request: chat not found"},
		{"discord message", "discord", `{"message":"Unknown Webhook","code":10015}`, 404, "discord returned status 404: Unknown Webhook"},
		{"empty body falls back to status only", "slack", ``, 500, "slack returned status 500"},
		{"non-json body used verbatim", "pagerduty", "oops", 502, "pagerduty returned status 502: oops"},
	}
	for _, c := range cases {
		got := httpErrDetail(c.provider, utils.HTTPResult{Body: []byte(c.body), StatusCode: c.code}).Error()
		if got != c.want {
			t.Errorf("%s: httpErrDetail = %q, want %q", c.name, got, c.want)
		}
	}
}

func TestNotifyEventMessage(t *testing.T) {
	cases := []struct {
		sent, total int
		note        string
		want        string
	}{
		{0, 0, "", "No alert channels configured"},
		{2, 2, "", "Notified 2 channel(s)"},
		{1, 2, "1 failed to send", "Notified 1 of 2 channel(s) — 1 failed to send"},
		{0, 1, "1 email skipped (SMTP not configured)", "Notification failed — 0 of 1 channel(s) sent — 1 email skipped (SMTP not configured)"},
	}
	for _, c := range cases {
		if got := notifyEventMessage(c.sent, c.total, c.note); got != c.want {
			t.Errorf("notifyEventMessage(%d,%d,%q) = %q, want %q", c.sent, c.total, c.note, got, c.want)
		}
	}
}

func TestParseTelegramTarget(t *testing.T) {
	// The bot token itself contains a colon ("<id>:<hash>"), so the split must
	// key off the LAST colon, not the first.
	ok := []struct {
		target, token, chat string
	}{
		{"123456:ABC-DEF_ghi:-1001234567890", "123456:ABC-DEF_ghi", "-1001234567890"},
		{"123456:ABC-DEF_ghi:@mychannel", "123456:ABC-DEF_ghi", "@mychannel"},
		{"123456:hash:987654321", "123456:hash", "987654321"},
	}
	for _, c := range ok {
		token, chat, err := parseTelegramTarget(c.target)
		if err != nil {
			t.Errorf("parseTelegramTarget(%q) unexpected error: %s", c.target, err)
			continue
		}
		if token != c.token || chat != c.chat {
			t.Errorf("parseTelegramTarget(%q) = (%q, %q), want (%q, %q)", c.target, token, chat, c.token, c.chat)
		}
	}

	bad := []string{"", "nocolon", ":chatonly", "tokenonly:"}
	for _, target := range bad {
		if _, _, err := parseTelegramTarget(target); err == nil {
			t.Errorf("parseTelegramTarget(%q) expected error, got nil", target)
		}
	}
}

func TestHumanizeDowntime(t *testing.T) {
	if got := humanizeDowntime("2026-07-25T10:00:00Z", "2026-07-25T10:03:12Z"); got != "3m12s" {
		t.Errorf("downtime = %q, want 3m12s", got)
	}
	// bad / inverted inputs degrade gracefully
	if got := humanizeDowntime("", "2026-07-25T10:00:00Z"); got != "unknown" {
		t.Errorf("downtime(empty start) = %q, want unknown", got)
	}
	if got := humanizeDowntime("2026-07-25T10:05:00Z", "2026-07-25T10:00:00Z"); got != "unknown" {
		t.Errorf("downtime(resolved before started) = %q, want unknown", got)
	}
}

func TestPagerDutyEvent(t *testing.T) {
	// A trigger carries the alert payload and the incident's dedup key.
	trig := pagerDutyEvent("rk", "DOWN", "details", "inc123", "trigger")
	if trig["event_action"] != "trigger" {
		t.Errorf("trigger event_action = %v, want trigger", trig["event_action"])
	}
	if trig["dedup_key"] != "inc123" {
		t.Errorf("trigger dedup_key = %v, want inc123", trig["dedup_key"])
	}
	if _, ok := trig["payload"]; !ok {
		t.Error("trigger must include a payload block")
	}

	// A resolve reuses the SAME dedup key (so it closes that incident) and omits
	// the payload block per the Events API v2 spec.
	res := pagerDutyEvent("rk", "UP", "details", "inc123", "resolve")
	if res["event_action"] != "resolve" {
		t.Errorf("resolve event_action = %v, want resolve", res["event_action"])
	}
	if res["dedup_key"] != "inc123" {
		t.Errorf("resolve dedup_key = %v, want inc123 (must match the trigger)", res["dedup_key"])
	}
	if _, ok := res["payload"]; ok {
		t.Error("resolve must not include a payload block")
	}

	// No dedup key (e.g. a test alert): omit the field, default to trigger.
	bare := pagerDutyEvent("rk", "s", "b", "", "")
	if bare["event_action"] != "trigger" {
		t.Errorf("empty action = %v, want trigger", bare["event_action"])
	}
	if _, ok := bare["dedup_key"]; ok {
		t.Error("no dedup key should omit the field entirely")
	}
}
