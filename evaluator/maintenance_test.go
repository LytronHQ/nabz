package main

import (
	"testing"
	"time"

	"monitors/corelib/models"
)

func TestInMaintenance(t *testing.T) {
	now := time.Now().UTC()
	iso := func(tm time.Time) string { return tm.Format(time.RFC3339) }
	mon := func(ws ...models.MaintenanceWindow) models.Monitor {
		return models.Monitor{Config: models.MonitorConfig{MaintenanceWindows: ws}}
	}

	active := models.MaintenanceWindow{Start: iso(now.Add(-time.Hour)), End: iso(now.Add(time.Hour))}
	past := models.MaintenanceWindow{Start: iso(now.Add(-2 * time.Hour)), End: iso(now.Add(-time.Hour))}
	future := models.MaintenanceWindow{Start: iso(now.Add(time.Hour)), End: iso(now.Add(2 * time.Hour))}

	if !inMaintenance(mon(active), now) {
		t.Fatal("expected in maintenance during an active window")
	}
	if inMaintenance(mon(past, future), now) {
		t.Fatal("past/future windows should not be active")
	}
	if inMaintenance(mon(), now) {
		t.Fatal("no windows means not in maintenance")
	}
	if inMaintenance(mon(models.MaintenanceWindow{Start: "nope", End: "nope"}), now) {
		t.Fatal("a malformed window must not put a monitor in maintenance")
	}
	// One active among several still counts.
	if !inMaintenance(mon(past, active, future), now) {
		t.Fatal("an active window among others should count")
	}
}
