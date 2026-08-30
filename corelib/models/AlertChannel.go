package models

// AlertChannel is a destination a user's alerts are sent to, from the
// `alert_channels` collection.
type AlertChannel struct {
	Id   string `json:"id"`
	User string `json:"user"`
	Type string `json:"type"` // email | webhook | slack | discord | telegram | pagerduty
	// Target is the legacy single-string destination. Superseded by Config; kept
	// so channels created before the structured-config change keep working.
	Target  string             `json:"target"`
	Config  AlertChannelConfig `json:"config"`
	Enabled bool               `json:"enabled"`
}

// AlertChannelConfig holds the per-type settings for a channel (the `config`
// JSON field). Each type reads only the fields it needs; the rest stay empty.
type AlertChannelConfig struct {
	Email      string `json:"email,omitempty"`      // email
	URL        string `json:"url,omitempty"`        // webhook, slack, discord
	BotToken   string `json:"botToken,omitempty"`   // telegram
	ChatID     string `json:"chatId,omitempty"`     // telegram
	RoutingKey string `json:"routingKey,omitempty"` // pagerduty
}

// Address returns the single destination/credential for the single-value channel
// types, preferring the structured config and falling back to the legacy target.
// (Telegram has two values — read Config.BotToken/ChatID directly.)
func (a AlertChannel) Address() string {
	switch a.Type {
	case "email":
		if a.Config.Email != "" {
			return a.Config.Email
		}
	case "webhook", "slack", "discord":
		if a.Config.URL != "" {
			return a.Config.URL
		}
	case "pagerduty":
		if a.Config.RoutingKey != "" {
			return a.Config.RoutingKey
		}
	}
	return a.Target
}
