import type PocketBase from 'pocketbase';

/**
 * Multi-window availability for a monitor, read from the `rollups` collection
 * (never a raw-check scan) plus the `incidents` collection.
 *
 * Availability % is count-weighted across rollup buckets, tiered by granularity:
 *   today      -> hour rollups
 *   before that-> day rollups (completed days)
 * so the current partial day is included. Downtime / incident stats come from
 * `incidents` (which are not purged), clipped to each window, so they stay
 * accurate even past rollup retention.
 */

function pbDate(d: Date): string {
	return d.toISOString().replace('T', ' ');
}

// PocketBase returns datetimes as "YYYY-MM-DD HH:mm:ss.SSSZ"; normalize for Date.
function parseTime(s: string): number {
	if (!s) return NaN;
	return new Date(s.replace(' ', 'T')).getTime();
}

type RollupRow = { bucket_start: string; uptime_pct: number; check_count: number };
type IncidentRow = { started_at: string; resolved_at: string };

export type WindowStat = {
	label: string;
	availability: number | null; // percent (2dp), null when no rollup data yet
	downtimeMs: number;
	incidents: number;
	longestMs: number;
	avgMs: number; // mean in-window incident duration
};

function weightedUptime(
	rows: RollupRow[],
	/** Raw up/total for a window no rollup covers yet (#398). */
	extra: { up: number; total: number } = { up: 0, total: 0 }
): number | null {
	let up = extra.up;
	let total = extra.total;
	for (const r of rows) {
		const c = r.check_count ?? 0;
		if (!c) continue;
		total += c;
		up += ((r.uptime_pct ?? 0) / 100) * c;
	}
	if (total === 0) return null;
	return Math.round((up / total) * 10000) / 100;
}

// Downtime/incident stats for [from, to): each incident's overlap with the
// window contributes; longest/avg use those clipped durations.
function incidentStats(incidents: IncidentRow[], from: Date, to: Date) {
	const f = from.getTime();
	const t = to.getTime();
	let downtimeMs = 0;
	let longestMs = 0;
	let count = 0;
	for (const i of incidents) {
		const s = parseTime(i.started_at);
		if (Number.isNaN(s)) continue;
		const e = i.resolved_at ? parseTime(i.resolved_at) : t;
		const os = Math.max(s, f);
		const oe = Math.min(e, t);
		const dur = oe - os;
		if (dur <= 0) continue;
		count++;
		downtimeMs += dur;
		if (dur > longestMs) longestMs = dur;
	}
	return {
		downtimeMs,
		incidents: count,
		longestMs,
		avgMs: count ? Math.round(downtimeMs / count) : 0
	};
}

async function fetchRollups(
	pb: PocketBase,
	monitorId: string,
	period: string,
	from: Date,
	to: Date
): Promise<RollupRow[]> {
	try {
		return (await pb.collection('rollups').getFullList({
			filter: `monitor="${monitorId}" && period="${period}" && bucket_start >= "${pbDate(from)}" && bucket_start < "${pbDate(to)}"`,
			fields: 'bucket_start,uptime_pct,check_count',
			sort: 'bucket_start'
		})) as unknown as RollupRow[];
	} catch (err) {
		console.warn(`fetchRollups(${period}) failed:`, err);
		return [];
	}
}

async function fetchIncidents(pb: PocketBase, monitorId: string): Promise<IncidentRow[]> {
	try {
		return (await pb.collection('incidents').getFullList({
			filter: `monitor="${monitorId}"`,
			fields: 'started_at,resolved_at',
			sort: 'started_at'
		})) as unknown as IncidentRow[];
	} catch (err) {
		console.warn('fetchIncidents failed:', err);
		return [];
	}
}

function startOfUTCDay(d: Date): Date {
	return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

const DAY_MS = 86_400_000;

/** Aggregate prefetched rollups into an availability % for [from, to). */
function availabilityFor(
	from: Date,
	to: Date,
	startToday: Date,
	hourRoll: RollupRow[],
	dayRoll: RollupRow[]
): number | null {
	const f = from.getTime();
	const st = startToday.getTime();
	const recs: RollupRow[] = [];
	for (const r of hourRoll) {
		const t = parseTime(r.bucket_start);
		if (t >= Math.max(f, st) && t < to.getTime()) recs.push(r);
	}
	for (const r of dayRoll) {
		const t = parseTime(r.bucket_start);
		if (t >= f && t < st) recs.push(r);
	}
	return weightedUptime(recs);
}

/** The 5 standard windows, computed in memory from one prefetch. */
export async function getAvailabilityTable(
	pb: PocketBase,
	monitorId: string,
	now: Date = new Date()
): Promise<WindowStat[]> {
	const startToday = startOfUTCDay(now);

	const [hourRoll, dayRoll, incidents] = await Promise.all([
		fetchRollups(pb, monitorId, 'hour', startToday, now),
		// all completed-day rollups (getFullList paginates); newest-first not needed
		fetchRollups(pb, monitorId, 'day', new Date(0), startToday),
		fetchIncidents(pb, monitorId)
	]);

	const windows: { label: string; from: Date }[] = [
		{ label: 'Today', from: startToday },
		{ label: 'Last 7 days', from: new Date(startToday.getTime() - 6 * DAY_MS) },
		{ label: 'Last 30 days', from: new Date(startToday.getTime() - 29 * DAY_MS) },
		{ label: 'Last 365 days', from: new Date(startToday.getTime() - 364 * DAY_MS) },
		{ label: 'All time', from: new Date(0) }
	];

	return windows.map((w) => ({
		label: w.label,
		availability: availabilityFor(w.from, now, startToday, hourRoll, dayRoll),
		...incidentStats(incidents, w.from, now)
	}));
}

// Clipped down-intervals for [from, to): each incident's overlap with the window,
// used to paint the uptime bar's red segments precisely (incident timestamps are
// exact, independent of rollup granularity).
function incidentIntervals(
	incidents: IncidentRow[],
	from: Date,
	to: Date
): { s: number; e: number }[] {
	const f = from.getTime();
	const t = to.getTime();
	const out: { s: number; e: number }[] = [];
	for (const i of incidents) {
		const s = parseTime(i.started_at);
		if (Number.isNaN(s)) continue;
		const e = i.resolved_at ? parseTime(i.resolved_at) : t;
		const os = Math.max(s, f);
		const oe = Math.min(e, t);
		if (oe > os) out.push({ s: os, e: oe });
	}
	return out;
}

export type OverviewRange = {
	key: '24h' | '7d' | '30d';
	label: string;
	availability: number | null; // percent (2dp), null when no rollup data yet
	downtimeMs: number;
	incidents: number;
	fromMs: number;
	toMs: number;
	dataStartMs: number; // earliest point we have data for; the bar is muted before it
	down: { s: number; e: number }[]; // clipped down intervals within [from, to)
};

/**
 * At-a-glance availability for the monitor-detail "Availability" card: three
 * rolling windows (24h / 7d / 30d), each with an uptime %, downtime, incident
 * count, and the precise down-intervals that paint the uptime bar. Computed from
 * one prefetch so the client range toggle is instant (no refetch), mirroring
 * getAvailabilityTable. Uptime comes from rollups; the bar's red from incidents.
 */
/** Up/total from raw `checks` for the CURRENT, not-yet-closed hour (#398).
 *
 *  Rollups only close on the hour, so the newest bucket can be up to 60 minutes
 *  old — and a monitor created minutes ago has no bucket at all. Reading only
 *  rollups then reports `—` for a monitor that is demonstrably being checked,
 *  while the header tile, which counts raw `checks`, shows a real percentage on
 *  the same page.
 *
 *  Bounded to at most one hour of rows for one monitor, and only two COUNT
 *  queries — the same shape #324 used for the fleet figure on the dashboard. */
async function partialHour(
	pb: PocketBase,
	monitorId: string,
	now: Date
): Promise<{ up: number; total: number }> {
	const hourStart = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000);
	const base = `monitor="${monitorId}" && checked_at >= "${pbDate(hourStart)}"`;
	try {
		const total = await pb.collection('checks').getList(1, 1, { filter: base });
		if (total.totalItems === 0) return { up: 0, total: 0 };
		const up = await pb.collection('checks').getList(1, 1, { filter: `${base} && up=true` });
		return { up: up.totalItems, total: total.totalItems };
	} catch {
		// Decoration, not correctness: a failed read falls back to rollups alone
		// rather than failing the page.
		return { up: 0, total: 0 };
	}
}

export async function getAvailabilityOverview(
	pb: PocketBase,
	monitorId: string,
	now: Date = new Date()
): Promise<OverviewRange[]> {
	const startToday = startOfUTCDay(now);
	// Hour rollups back far enough to cover a rolling 24h at hour granularity.
	const hourFrom = new Date(now.getTime() - 25 * 3_600_000);

	const [hourRoll, dayRoll, incidents, partial] = await Promise.all([
		fetchRollups(pb, monitorId, 'hour', hourFrom, now),
		fetchRollups(pb, monitorId, 'day', new Date(0), startToday),
		fetchIncidents(pb, monitorId),
		partialHour(pb, monitorId, now)
	]);

	// The bar shows segments before we have any data as muted, not fake green.
	// Data-start = the earliest thing we actually recorded (oldest rollup bucket
	// or incident) — a monitor can exist without data, so `created` isn't it.
	const points = [
		...hourRoll.map((r) => parseTime(r.bucket_start)),
		...dayRoll.map((r) => parseTime(r.bucket_start)),
		...incidents.map((i) => parseTime(i.started_at))
	].filter((n) => !Number.isNaN(n));
	// Checks in the in-flight hour are data too. Without this a brand-new monitor
	// has no points at all, dataStartMs collapses to `now`, and the whole bar
	// renders muted — "no data" — while checks are visibly arriving.
	if (partial.total > 0) points.push(Math.floor(now.getTime() / 3_600_000) * 3_600_000);
	const dataStartMs = points.length ? Math.min(...points) : now.getTime();

	// 24h uptime uses hour rollups only (a rolling 24h crosses midnight, so day
	// rollups would over-count the partial prior day); 7d/30d use the tiered mix.
	const uptime24h = weightedUptime(
		hourRoll.filter((r) => {
			const t = parseTime(r.bucket_start);
			return t >= now.getTime() - DAY_MS && t < now.getTime();
		}),
		// The hour no bucket covers yet. Folded in with the same weighting, so the
		// result stays arithmetically identical to counting the raw rows.
		partial
	);

	const ranges: { key: '24h' | '7d' | '30d'; label: string; ms: number }[] = [
		{ key: '24h', label: '24h', ms: DAY_MS },
		{ key: '7d', label: '7d', ms: 7 * DAY_MS },
		{ key: '30d', label: '30d', ms: 30 * DAY_MS }
	];

	return ranges.map((r) => {
		const from = new Date(now.getTime() - r.ms);
		const down = incidentIntervals(incidents, from, now);
		return {
			key: r.key,
			label: r.label,
			availability:
				r.key === '24h' ? uptime24h : availabilityFor(from, now, startToday, hourRoll, dayRoll),
			downtimeMs: down.reduce((a, d) => a + (d.e - d.s), 0),
			incidents: down.length,
			fromMs: from.getTime(),
			toMs: now.getTime(),
			dataStartMs,
			down
		};
	});
}

/** A single arbitrary range — backs the From/To calculator. */
export async function computeAvailability(
	pb: PocketBase,
	monitorId: string,
	from: Date,
	to: Date
): Promise<WindowStat> {
	const startToday = startOfUTCDay(to < new Date() ? to : new Date());
	const hourFrom = new Date(Math.max(from.getTime(), startToday.getTime()));

	const [hourRoll, dayRoll, incidents] = await Promise.all([
		hourFrom < to
			? fetchRollups(pb, monitorId, 'hour', hourFrom, to)
			: Promise.resolve([] as RollupRow[]),
		fetchRollups(pb, monitorId, 'day', from, startToday < to ? startToday : to),
		fetchIncidents(pb, monitorId)
	]);

	return {
		label: 'Custom',
		availability: availabilityFor(from, to, startToday, hourRoll, dayRoll),
		...incidentStats(incidents, from, to)
	};
}
