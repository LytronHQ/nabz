package main

import (
	"bufio"
	"bytes"
	"net"
	"strings"
	"testing"
	"time"

	"monitors/corelib/models"
)

// Offline email-channel coverage (#288, part of #126). Stands up an in-process SMTP
// server and points sendEmail/dispatch at it — no credentials, no containers, no
// external accounts. Real-provider deliverability is covered separately by the prod
// canary, not CI.

// serveSMTP runs the minimal SMTP conversation smtp.SendMail expects and returns the
// captured DATA payload. It deliberately does NOT advertise STARTTLS (SendMail would
// try it and fail against a self-signed cert) and DOES advertise AUTH PLAIN (so a
// client carrying smtp.PlainAuth isn't rejected with "server doesn't support AUTH").
func serveSMTP(conn net.Conn) []byte {
	defer conn.Close()
	br := bufio.NewReader(conn)
	bw := bufio.NewWriter(conn)
	reply := func(s string) { _, _ = bw.WriteString(s); _ = bw.Flush() }

	reply("220 localhost ESMTP sink\r\n")
	var data bytes.Buffer
	for {
		line, err := br.ReadString('\n')
		if err != nil {
			return data.Bytes()
		}
		cmd := strings.ToUpper(strings.TrimSpace(line))
		switch {
		case strings.HasPrefix(cmd, "EHLO"), strings.HasPrefix(cmd, "HELO"):
			// First line = greeting; then advertised extensions. AUTH PLAIN yes,
			// STARTTLS deliberately absent.
			reply("250-localhost\r\n250 AUTH PLAIN\r\n")
		case strings.HasPrefix(cmd, "AUTH"):
			reply("235 2.7.0 Authentication successful\r\n")
		case strings.HasPrefix(cmd, "MAIL FROM"):
			reply("250 2.1.0 Ok\r\n")
		case strings.HasPrefix(cmd, "RCPT TO"):
			reply("250 2.1.5 Ok\r\n")
		case cmd == "DATA":
			reply("354 End data with <CR><LF>.<CR><LF>\r\n")
			for {
				l, err := br.ReadString('\n')
				if err != nil {
					return data.Bytes()
				}
				if l == ".\r\n" {
					break // end of DATA
				}
				// Undo SMTP dot-stuffing (a body line starting with '.' is doubled).
				if strings.HasPrefix(l, "..") {
					l = l[1:]
				}
				data.WriteString(l)
			}
			reply("250 2.0.0 Ok: queued\r\n")
		case cmd == "QUIT":
			reply("221 2.0.0 Bye\r\n")
			return data.Bytes()
		default:
			reply("250 2.0.0 Ok\r\n")
		}
	}
}

// startSMTPSink binds a one-shot SMTP sink to 127.0.0.1:0 (loopback so
// smtp.PlainAuth will send credentials over the unencrypted connection) and returns
// its host, port, and a channel delivering the captured message. Torn down via
// t.Cleanup; readiness is the returned listener address, so no fixed ports/sleeps.
func startSMTPSink(t *testing.T) (host, port string, captured <-chan []byte) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	h, p, err := net.SplitHostPort(ln.Addr().String())
	if err != nil {
		t.Fatalf("split addr: %v", err)
	}
	ch := make(chan []byte, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return // listener closed by cleanup
		}
		ch <- serveSMTP(conn)
	}()
	return h, p, ch
}

func TestEmailEnabled(t *testing.T) {
	cases := []struct {
		name string
		cfg  alertConfig
		want bool
	}{
		{"empty", alertConfig{}, false},
		{"host only", alertConfig{smtpHost: "smtp.example.com"}, false},
		{"from only", alertConfig{smtpFrom: "alerts@nabz.sh"}, false},
		{"host + from", alertConfig{smtpHost: "smtp.example.com", smtpFrom: "alerts@nabz.sh"}, true},
	}
	for _, c := range cases {
		if got := c.cfg.emailEnabled(); got != c.want {
			t.Errorf("%s: emailEnabled() = %v, want %v", c.name, got, c.want)
		}
	}
}

func TestSendEmailBuildsValidMessage(t *testing.T) {
	host, port, captured := startSMTPSink(t)
	cfg := alertConfig{smtpHost: host, smtpPort: port, smtpUser: "user", smtpPass: "pass", smtpFrom: "alerts@nabz.sh"}

	if err := sendEmail(cfg, "dev@example.com", "[nabz] example.com is DOWN", "example.com is down."); err != nil {
		t.Fatalf("sendEmail: %v", err)
	}

	var raw []byte
	select {
	case raw = <-captured:
	case <-time.After(5 * time.Second):
		t.Fatal("sink captured no message")
	}
	msg := string(raw)

	// Headers present, each terminated with CRLF.
	for _, h := range []string{
		"From: alerts@nabz.sh\r\n",
		"To: dev@example.com\r\n",
		"Subject: [nabz] example.com is DOWN\r\n",
	} {
		if !strings.Contains(msg, h) {
			t.Errorf("message missing header %q\n--- message ---\n%q", h, msg)
		}
	}
	// A blank line separates headers from body, then the body itself.
	if !strings.Contains(msg, "\r\n\r\nexample.com is down.") {
		t.Errorf("message missing header/body separator or body\n--- message ---\n%q", msg)
	}
	// Every newline must be CRLF — a bare \n passes a hand-rolled sink but a real
	// MTA rejects it.
	if n, crlf := strings.Count(msg, "\n"), strings.Count(msg, "\r\n"); n != crlf {
		t.Errorf("message has bare LF (%d newlines, %d CRLF)\n--- message ---\n%q", n, crlf, msg)
	}
}

func TestDispatchEmailChannel(t *testing.T) {
	ch := models.AlertChannel{Type: "email", Config: models.AlertChannelConfig{Email: "dev@example.com"}}

	// Unconfigured SMTP → the channel is skipped, not attempted.
	res := dispatch(alertConfig{}, []models.AlertChannel{ch}, "subject", "body", nil)
	if len(res) != 1 || res[0].Outcome != "skipped" {
		t.Fatalf("unconfigured email: got %+v, want one result outcome=skipped", res)
	}

	// Configured → the send path runs and the message reaches the sink.
	host, port, captured := startSMTPSink(t)
	cfg := alertConfig{smtpHost: host, smtpPort: port, smtpUser: "u", smtpPass: "p", smtpFrom: "alerts@nabz.sh"}
	res = dispatch(cfg, []models.AlertChannel{ch}, "[nabz] test", "hello", nil)
	if len(res) != 1 || res[0].Outcome != "delivered" {
		t.Fatalf("configured email: got %+v, want one result outcome=delivered", res)
	}
	select {
	case raw := <-captured:
		if !strings.Contains(string(raw), "To: dev@example.com\r\n") {
			t.Errorf("dispatched email missing recipient header:\n%q", raw)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("sink captured no message from dispatch")
	}
}
