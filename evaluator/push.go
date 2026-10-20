package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
	"unicode/utf8"

	webpush "github.com/SherClockHolmes/webpush-go"

	"monitors/corelib/models"
	"monitors/corelib/utils"
)

// pushTTL is how long a push service holds an alert for a device that is offline.
// Past that, a "down" alert is old news: the incident page says more.
const pushTTL = 6 * 60 * 60

// pushBodyMax keeps the encrypted payload well under the 4 KB push services
// accept (Apple rejects more with PayloadTooLarge).
const pushBodyMax = 1000

var pushHTTPClient = &http.Client{Timeout: 15 * time.Second}

// pushMessage is what the service worker's push handler reads to show the
// notification. Every push must show one: Safari revokes the permission of a
// site that sends a push without displaying it.
type pushMessage struct {
	Title string `json:"title"`
	Body  string `json:"body"`
	URL   string `json:"url"`
	Tag   string `json:"tag,omitempty"`
}

// pushTarget picks the page a tap on the notification opens, and the tag that
// lets a later notification about the same thing replace the earlier one.
func pushTarget(payload map[string]interface{}) (url, tag string) {
	if id, _ := payload["incident_id"].(string); id != "" {
		return "/incidents/" + id, "incident-" + id
	}
	if id, _ := payload["monitor_id"].(string); id != "" {
		return "/monitors/" + id, "monitor-" + id
	}
	return "/alerts", ""
}

func buildPushMessage(subject, body string, payload map[string]interface{}) pushMessage {
	if len(body) > pushBodyMax {
		cut := pushBodyMax
		for cut > 0 && !utf8.RuneStart(body[cut]) {
			cut--
		}
		body = body[:cut] + "…"
	}
	url, tag := pushTarget(payload)
	return pushMessage{Title: subject, Body: body, URL: url, Tag: tag}
}

// sendPush delivers one alert to one device's push subscription.
func sendPush(cfg alertConfig, ch models.AlertChannel, subject, body string, payload map[string]interface{}) error {
	c := ch.Config
	if c.Endpoint == "" || c.P256dh == "" || c.Auth == "" {
		return fmt.Errorf("this channel has no device subscription: turn notifications on from the channel page")
	}
	msg, _ := json.Marshal(buildPushMessage(subject, body, payload))
	_, tag := pushTarget(payload)
	res, err := webpush.SendNotification(msg, &webpush.Subscription{
		Endpoint: c.Endpoint,
		Keys:     webpush.Keys{P256dh: c.P256dh, Auth: c.Auth},
	}, &webpush.Options{
		HTTPClient:      pushHTTPClient,
		Subscriber:      cfg.vapidSubject,
		VAPIDPublicKey:  cfg.vapidPublic,
		VAPIDPrivateKey: cfg.vapidPrivate,
		TTL:             pushTTL,
		Urgency:         webpush.UrgencyHigh,
		// Coalesces alerts about the same thing queued for an offline device, so
		// it wakes to the latest state rather than a stack of stale ones.
		Topic: pushTopic(tag),
	})
	if err != nil {
		return fmt.Errorf("push: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode >= 200 && res.StatusCode < 300 {
		return nil
	}
	b, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
	if res.StatusCode == http.StatusNotFound || res.StatusCode == http.StatusGone {
		// The device unsubscribed, the browser data was cleared, or the app was
		// removed. Nothing will reach it until the user turns notifications on again.
		return fmt.Errorf("push subscription has expired (status %d): turn notifications on again on that device", res.StatusCode)
	}
	return httpErrDetail("push service", utils.HTTPResult{StatusCode: res.StatusCode, Body: b})
}

// pushTopic makes a Topic header value: at most 32 URL-safe characters.
func pushTopic(tag string) string {
	out := make([]byte, 0, 32)
	for i := 0; i < len(tag) && len(out) < 32; i++ {
		ch := tag[i]
		if ch == '-' || ch == '_' || (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') {
			out = append(out, ch)
		}
	}
	return string(out)
}
