package main

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"unicode/utf8"

	webpush "github.com/SherClockHolmes/webpush-go"
	"golang.org/x/crypto/hkdf"

	"monitors/corelib/models"
)

// device is a browser's side of a push subscription: the key pair and auth
// secret it generates, so the test can decrypt what the evaluator sends.
type device struct {
	priv *ecdh.PrivateKey
	auth []byte
}

func newDevice(t *testing.T) device {
	t.Helper()
	priv, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	auth := make([]byte, 16)
	if _, err := rand.Read(auth); err != nil {
		t.Fatal(err)
	}
	return device{priv: priv, auth: auth}
}

func (d device) channel(endpoint string) models.AlertChannel {
	b64 := base64.RawURLEncoding.EncodeToString
	return models.AlertChannel{Id: "ch1", Type: "push", Enabled: true, Config: models.AlertChannelConfig{
		Endpoint: endpoint, P256dh: b64(d.priv.PublicKey().Bytes()), Auth: b64(d.auth),
	}}
}

// decrypt undoes RFC 8291 (aes128gcm), as the browser does on receipt.
func (d device) decrypt(t *testing.T, body []byte) []byte {
	t.Helper()
	salt, rs, idlen := body[:16], binary.BigEndian.Uint32(body[16:20]), int(body[20])
	asPub, ct := body[21:21+idlen], body[21+idlen:]
	if int(rs) < len(ct) {
		t.Fatalf("record size %d smaller than ciphertext %d", rs, len(ct))
	}
	serverKey, err := ecdh.P256().NewPublicKey(asPub)
	if err != nil {
		t.Fatal(err)
	}
	shared, err := d.priv.ECDH(serverKey)
	if err != nil {
		t.Fatal(err)
	}
	read := func(r io.Reader, n int) []byte {
		b := make([]byte, n)
		if _, err := io.ReadFull(r, b); err != nil {
			t.Fatal(err)
		}
		return b
	}
	info := append([]byte("WebPush: info\x00"), d.priv.PublicKey().Bytes()...)
	info = append(info, asPub...)
	ikm := read(hkdf.New(sha256.New, shared, d.auth, info), 32)
	cek := read(hkdf.New(sha256.New, ikm, salt, []byte("Content-Encoding: aes128gcm\x00")), 16)
	nonce := read(hkdf.New(sha256.New, ikm, salt, []byte("Content-Encoding: nonce\x00")), 12)
	block, _ := aes.NewCipher(cek)
	gcm, _ := cipher.NewGCM(block)
	plain, err := gcm.Open(nil, nonce, ct, nil)
	if err != nil {
		t.Fatalf("decrypt: %v", err)
	}
	// Strip the padding: the last record ends with 0x02 followed by zeros.
	i := bytes.LastIndexByte(plain, 2)
	if i < 0 {
		t.Fatal("no padding delimiter")
	}
	return plain[:i]
}

func pushCfg(t *testing.T) alertConfig {
	t.Helper()
	priv, pub, err := webpush.GenerateVAPIDKeys()
	if err != nil {
		t.Fatal(err)
	}
	return alertConfig{vapidPublic: pub, vapidPrivate: priv, vapidSubject: "https://nabz.sh"}
}

func TestSendPushDeliversAnEncryptedNotification(t *testing.T) {
	dev := newDevice(t)
	cfg := pushCfg(t)
	var got *http.Request
	var body []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Clone(r.Context())
		body, _ = io.ReadAll(r.Body)
		w.WriteHeader(http.StatusCreated)
	}))
	defer srv.Close()

	payload := map[string]interface{}{"event": "incident.opened", "incident_id": "inc123", "monitor_id": "mon1"}
	if err := sendPush(cfg, dev.channel(srv.URL), "[nabz] API is DOWN", "API (https://api.example) is down.", payload); err != nil {
		t.Fatalf("sendPush: %v", err)
	}
	if got == nil {
		t.Fatal("push service never called")
	}
	for h, want := range map[string]string{"Content-Encoding": "aes128gcm", "TTL": "21600", "Urgency": "high", "Topic": "incident-inc123"} {
		if v := got.Header.Get(h); v != want {
			t.Errorf("%s = %q, want %q", h, v, want)
		}
	}
	// VAPID: the token and the public key the device subscribed with.
	if a := got.Header.Get("Authorization"); !strings.HasPrefix(a, "vapid t=") || !strings.Contains(a, "k="+cfg.vapidPublic) {
		t.Errorf("Authorization = %q, want a vapid token carrying the public key", a)
	}

	var msg pushMessage
	if err := json.Unmarshal(dev.decrypt(t, body), &msg); err != nil {
		t.Fatalf("payload is not JSON: %v", err)
	}
	want := pushMessage{Title: "[nabz] API is DOWN", Body: "API (https://api.example) is down.", URL: "/incidents/inc123", Tag: "incident-inc123"}
	if msg != want {
		t.Fatalf("payload = %+v, want %+v", msg, want)
	}
}

func TestSendPushExpiredSubscription(t *testing.T) {
	for _, code := range []int{http.StatusNotFound, http.StatusGone} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(code) }))
		err := sendPush(pushCfg(t), newDevice(t).channel(srv.URL), "s", "b", map[string]interface{}{})
		srv.Close()
		if err == nil || !strings.Contains(err.Error(), "expired") || !strings.Contains(err.Error(), "turn notifications on again") {
			t.Fatalf("status %d: got %v, want an expired-subscription error telling the user what to do", code, err)
		}
	}
}

// Apple's push service explains a rejection in {"reason": ...}; the delivery log
// should carry it rather than a bare status.
func TestSendPushReportsTheServiceReason(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		w.Write([]byte(`{"reason":"BadJwtToken"}`))
	}))
	defer srv.Close()
	err := sendPush(pushCfg(t), newDevice(t).channel(srv.URL), "s", "b", map[string]interface{}{})
	if err == nil || !strings.Contains(err.Error(), "403") || !strings.Contains(err.Error(), "BadJwtToken") {
		t.Fatalf("got %v, want status 403 with BadJwtToken", err)
	}
}

func TestSendPushWithoutASubscription(t *testing.T) {
	err := sendPush(pushCfg(t), models.AlertChannel{Type: "push"}, "s", "b", map[string]interface{}{})
	if err == nil || !strings.Contains(err.Error(), "no device subscription") {
		t.Fatalf("got %v", err)
	}
}

func TestDispatchSkipsPushWithoutKeys(t *testing.T) {
	results := dispatch(alertConfig{}, []models.AlertChannel{newDevice(t).channel("https://push.example/x")}, "s", "b", map[string]interface{}{})
	if len(results) != 1 || results[0].Outcome != "skipped" {
		t.Fatalf("got %+v, want one skipped result", results)
	}
	sent, note := summarize(results)
	if sent != 0 || note != "1 push skipped (push keys not configured)" {
		t.Fatalf("summarize = %d, %q", sent, note)
	}
}

func TestPushTarget(t *testing.T) {
	cases := []struct {
		payload        map[string]interface{}
		wantURL, wantT string
	}{
		{map[string]interface{}{"incident_id": "i1", "monitor_id": "m1"}, "/incidents/i1", "incident-i1"},
		{map[string]interface{}{"monitor_id": "m1"}, "/monitors/m1", "monitor-m1"},
		{map[string]interface{}{"event": "test"}, "/alerts", ""},
	}
	for _, c := range cases {
		if u, tag := pushTarget(c.payload); u != c.wantURL || tag != c.wantT {
			t.Errorf("pushTarget(%v) = %q, %q; want %q, %q", c.payload, u, tag, c.wantURL, c.wantT)
		}
	}
	if got := pushTopic(strings.Repeat("a", 40) + "!"); got != strings.Repeat("a", 32) {
		t.Errorf("pushTopic did not cap at 32 URL-safe characters: %q", got)
	}
}

func TestBuildPushMessageCapsTheBody(t *testing.T) {
	m := buildPushMessage("s", strings.Repeat("x", 3000), map[string]interface{}{})
	if len(m.Body) > pushBodyMax+len("…") {
		t.Fatalf("body is %d bytes", len(m.Body))
	}
	// A cut through a multi-byte character would leave invalid UTF-8.
	m = buildPushMessage("s", strings.Repeat("ب", 900), map[string]interface{}{})
	if !utf8.ValidString(m.Body) {
		t.Fatal("capped body is not valid UTF-8")
	}
}

// Keys minted by deploy/vapid-keys.sh (the CI path) must be a matching pair that
// webpush-go signs with. Run by deploy/vapid_keys_test.sh, which exports them.
func TestVAPIDKeysFromScript(t *testing.T) {
	pub, priv := os.Getenv("SCRIPT_VAPID_PUBLIC_KEY"), os.Getenv("SCRIPT_VAPID_PRIVATE_KEY")
	if pub == "" || priv == "" {
		t.Skip("run through deploy/vapid_keys_test.sh")
	}
	rawPriv, err := base64.RawURLEncoding.DecodeString(priv)
	if err != nil {
		t.Fatalf("private key is not base64url: %v", err)
	}
	key, err := ecdh.P256().NewPrivateKey(rawPriv)
	if err != nil {
		t.Fatalf("private key is not a P-256 scalar: %v", err)
	}
	if got := base64.RawURLEncoding.EncodeToString(key.PublicKey().Bytes()); got != pub {
		t.Fatalf("public key does not belong to the private key")
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusCreated) }))
	defer srv.Close()
	cfg := alertConfig{vapidPublic: pub, vapidPrivate: priv, vapidSubject: "https://nabz.sh"}
	if err := sendPush(cfg, newDevice(t).channel(srv.URL), "s", "b", map[string]interface{}{}); err != nil {
		t.Fatalf("webpush-go rejected the script's keys: %v", err)
	}
}
