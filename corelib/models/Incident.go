package models

// Incident is an open or resolved outage for a monitor, as stored in the
// `incidents` collection. ResolvedAt is empty ("") while the incident is open.
type Incident struct {
	Id         string `json:"id"`
	Monitor    string `json:"monitor"`
	StartedAt  string `json:"started_at"`
	ResolvedAt string `json:"resolved_at"`
	Cause      string `json:"cause"`
	Notified   bool   `json:"notified"`
	// RecoveryNotified is set once a recovery ("back up") alert has been sent, so
	// it fires at most once per incident.
	RecoveryNotified bool `json:"recovery_notified"`
	// AcknowledgedAt/By are set when a user takes ownership of the incident.
	AcknowledgedAt string `json:"acknowledged_at"`
	AcknowledgedBy string `json:"acknowledged_by"`
	EscalatedAt    string `json:"escalated_at"`
	// EscalationLevel is the count of escalation levels already fired.
	EscalationLevel int `json:"escalation_level"`
	// EscalateNow, set by the user's "Escalate" button, fires the next level
	// immediately on the next tick (bypassing its timer); the evaluator clears it.
	EscalateNow bool `json:"escalate_now"`
}

// IsAcknowledged reports whether someone has acknowledged the incident.
func (i Incident) IsAcknowledged() bool {
	return i.AcknowledgedAt != ""
}

// IsOpen reports whether the incident has not been resolved yet.
func (i Incident) IsOpen() bool {
	return i.ResolvedAt == ""
}
