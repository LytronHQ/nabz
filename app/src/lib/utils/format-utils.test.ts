import { test, expect } from 'vitest';
import {
	formatUptime,
	formatRelativeTime,
	formatMs,
	formatDuration,
	isStale,
	durationSeconds,
	isInMaintenance,
	formatNextCheck
} from './format-utils';

test('formatNextCheck', () => {
	const base = new Date('2026-07-28T00:00:00Z').getTime();
	const last = '2026-07-28T00:00:00Z';
	// disabled / no data
	expect(formatNextCheck(false, last, 60, base)).toBe('paused');
	expect(formatNextCheck(true, null, 60, base)).toBe('waiting for first check');
	expect(formatNextCheck(true, '', 60, base)).toBe('waiting for first check');
	// counting down: last + 60s, 18s elapsed -> 42s remaining
	expect(formatNextCheck(true, last, 60, base + 18_000)).toBe('next in 42s');
	// longer interval formats with minutes
	expect(formatNextCheck(true, last, 300, base + 100_000)).toBe('next in 3m 20s');
	// at/after due
	expect(formatNextCheck(true, last, 60, base + 60_000)).toBe('due now');
	expect(formatNextCheck(true, last, 60, base + 90_000)).toBe('due now');
	// unparseable lastChecked -> due now (no crash)
	expect(formatNextCheck(true, 'not-a-date', 60, base)).toBe('due now');
});

test('formatUptime', () => {
	expect(formatUptime(null)).toBe('—');
	expect(formatUptime(undefined)).toBe('—');
	expect(formatUptime(99.94)).toBe('99.9%');
	expect(formatUptime(100)).toBe('100.0%');
});

test('formatRelativeTime', () => {
	const now = 1_000_000_000_000;
	expect(formatRelativeTime(null, now)).toBe('never');
	expect(formatRelativeTime(new Date(now - 5_000).toISOString(), now)).toBe('5s ago');
	expect(formatRelativeTime(new Date(now - 120_000).toISOString(), now)).toBe('2m ago');
	expect(formatRelativeTime(new Date(now - 3 * 3_600_000).toISOString(), now)).toBe('3h ago');
	expect(formatRelativeTime(new Date(now - 2 * 86_400_000).toISOString(), now)).toBe('2d ago');
});

test('formatMs', () => {
	expect(formatMs(null)).toBe('—');
	expect(formatMs(123.6)).toBe('124 ms');
});

test('formatDuration', () => {
	expect(formatDuration(null)).toBe('—');
	expect(formatDuration(0)).toBe('0s');
	expect(formatDuration(45)).toBe('45s');
	expect(formatDuration(90)).toBe('1m 30s');
	expect(formatDuration(3720)).toBe('1h 2m');
});

test('durationSeconds', () => {
	const now = 1_000_000_000_000;
	expect(durationSeconds(null, null, now)).toBe(null);
	// resolved incident: fixed span
	expect(durationSeconds('2020-01-01 00:00:00.000Z', '2020-01-01 00:01:30.000Z', now)).toBe(90);
	// ongoing: measured to now (PocketBase space format is parsed)
	const start = new Date(now - 45_000).toISOString();
	expect(durationSeconds(start, null, now)).toBe(45);
});

test('isStale', () => {
	const now = 1_000_000_000_000;
	expect(isStale(null, 30, now)).toBe(true);
	expect(isStale(new Date(now - 10_000).toISOString(), 30, now)).toBe(false);
	expect(isStale(new Date(now - 40_000).toISOString(), 30, now)).toBe(true);
});

test('isInMaintenance detects an active window', () => {
	const now = Date.parse('2026-08-01T00:30:00Z');
	expect(
		isInMaintenance([{ start: '2026-08-01T00:00:00Z', end: '2026-08-01T01:00:00Z' }], now)
	).toBe(true);
	expect(
		isInMaintenance([{ start: '2026-08-01T02:00:00Z', end: '2026-08-01T03:00:00Z' }], now)
	).toBe(false);
	expect(isInMaintenance([], now)).toBe(false);
	expect(isInMaintenance(undefined, now)).toBe(false);
});
