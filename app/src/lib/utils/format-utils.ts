export function formatUptime(pct: number | null | undefined): string {
	if (pct === null || pct === undefined) return '—';
	return `${pct.toFixed(1)}%`;
}

// PocketBase serializes dates as "YYYY-MM-DD HH:mm:ss.SSSZ" (space, not "T").
// Normalize so every engine's Date parser accepts it.
function parseTs(value: string): number {
	return new Date(value.replace(' ', 'T')).getTime();
}

/** Seconds between start and end (end defaults to now); null on bad/absent input. */
export function durationSeconds(
	start: string | null | undefined,
	end: string | null | undefined,
	now: number = Date.now()
): number | null {
	if (!start) return null;
	const s = parseTs(start);
	if (Number.isNaN(s)) return null;
	const e = end ? parseTs(end) : now;
	if (Number.isNaN(e)) return null;
	return Math.max(0, (e - s) / 1000);
}

export function formatRelativeTime(
	value: string | null | undefined,
	now: number = Date.now()
): string {
	if (!value) return 'never';
	const then = parseTs(value);
	if (Number.isNaN(then)) return '—';

	const secs = Math.max(0, Math.round((now - then) / 1000));
	if (secs < 60) return `${secs}s ago`;
	const mins = Math.round(secs / 60);
	if (mins < 60) return `${mins}m ago`;
	const hrs = Math.round(mins / 60);
	if (hrs < 24) return `${hrs}h ago`;
	const days = Math.round(hrs / 24);
	return `${days}d ago`;
}

export function formatMs(ms: number | null | undefined): string {
	if (ms === null || ms === undefined) return '—';
	return `${Math.round(ms)} ms`;
}

/** True when `now` falls inside any of the monitor's maintenance windows. */
export function isInMaintenance(
	windows: { start: string; end: string }[] | undefined | null,
	now: number = Date.now()
): boolean {
	for (const w of windows ?? []) {
		const s = new Date(w.start).getTime();
		const e = new Date(w.end).getTime();
		if (Number.isFinite(s) && Number.isFinite(e) && now >= s && now < e) return true;
	}
	return false;
}

/**
 * The display state of a single check. 429/403 mean the target rate-limited or
 * bot-blocked us — neither up nor a real down — mirroring the worker/evaluator.
 */
export function checkState(c: {
	up?: boolean;
	status_code?: number | null;
}): 'up' | 'down' | 'rate-limited' {
	if (c.status_code === 429 || c.status_code === 403) return 'rate-limited';
	return c.up ? 'up' : 'down';
}

export function formatDuration(seconds: number | null | undefined): string {
	if (seconds === null || seconds === undefined) return '—';
	const s = Math.max(0, Math.round(seconds));
	if (s < 60) return `${s}s`;
	const mins = Math.floor(s / 60);
	if (mins < 60) return `${mins}m ${s % 60}s`;
	const hrs = Math.floor(mins / 60);
	return `${hrs}h ${mins % 60}m`;
}

/**
 * Live "next check" label for the monitor detail page (#122): an estimate of the
 * time to the next scheduled probe, from `lastChecked + interval`. Recomputed each
 * 1s `now` tick. 'paused' when disabled; 'waiting for first check' when there's no
 * lastChecked; 'due now' at/after due; otherwise 'next in <duration>'.
 */
export function formatNextCheck(
	enabled: boolean,
	lastChecked: string | null | undefined,
	intervalSeconds: number | null | undefined,
	now: number = Date.now()
): string {
	if (!enabled) return 'paused';
	if (!lastChecked) return 'waiting for first check';
	const next = new Date(lastChecked).getTime() + (intervalSeconds ?? 0) * 1000;
	if (!Number.isFinite(next)) return 'due now';
	const remaining = next - now;
	if (remaining <= 0) return 'due now';
	return `next in ${formatDuration(remaining / 1000)}`;
}

/** A heartbeat is stale if we haven't heard from it within `withinSeconds`. */
export function isStale(
	updated: string | null | undefined,
	withinSeconds = 30,
	now: number = Date.now()
): boolean {
	if (!updated) return true;
	const then = parseTs(updated);
	if (Number.isNaN(then)) return true;
	return now - then > withinSeconds * 1000;
}
