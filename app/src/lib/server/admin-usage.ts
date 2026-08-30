import type PocketBase from 'pocketbase';
import { isStale } from '$lib/utils/format-utils';
import { EVALUATOR_ZONE } from '$lib/server/health';

// Product-usage aggregation for /admin/usage (#246): "is nabz being used, and is
// that growing?" — a handful of counts on one screen, NOT an analytics product.
// Reads across all users via the web service account (its read rules were widened
// for the aggregation collections); every count is a getList(1,1).totalItems, and
// the whole payload is cached ~60s so a polling admin doesn't hammer PocketBase.

function pbDate(d: Date): string {
	return d.toISOString().replace('T', ' ');
}

// --- pure shaping helpers (unit-tested over fixture rows) ---

/** Distinct count of a string field across rows (e.g. active users = distinct
 *  owner among enabled monitors). */
export function distinctCount(rows: Array<Record<string, unknown>>, field: string): number {
	const seen = new Set<string>();
	for (const r of rows) {
		const v = r[field];
		if (typeof v === 'string' && v) seen.add(v);
	}
	return seen.size;
}

/** Count rows grouped by a field's value (e.g. channels by type). */
export function countBy(
	rows: Array<Record<string, unknown>>,
	field: string
): Record<string, number> {
	const out: Record<string, number> = {};
	for (const r of rows) {
		const v = String(r[field] ?? '');
		if (v) out[v] = (out[v] ?? 0) + 1;
	}
	return out;
}

/** Sum day-rollup check_count into a per-day series (fleet total per day),
 *  oldest→newest. Multiple monitors produce multiple rollups per day; they're
 *  summed by day. `bucket_start` is a timestamp; the day is its date part. */
export function checksPerDay(
	rollupRows: Array<{ bucket_start?: string; check_count?: number }>
): Array<{ day: string; checks: number }> {
	const byDay = new Map<string, number>();
	for (const r of rollupRows) {
		const day = (r.bucket_start ?? '').slice(0, 10);
		if (!day) continue;
		byDay.set(day, (byDay.get(day) ?? 0) + (r.check_count ?? 0));
	}
	return [...byDay.entries()]
		.sort((a, b) => a[0].localeCompare(b[0]))
		.map(([day, checks]) => ({ day, checks }));
}

// --- the aggregate ---

export type UsageStats = {
	generatedAt: string;
	users: { total: number; verified: number; newThisWeek: number; newThisMonth: number };
	monitors: { total: number; active: number; paused: number; newThisWeek: number };
	activeUsers: number; // distinct owners with ≥1 enabled monitor
	usersWithChannel: number;
	activity: {
		checksPerDay: Array<{ day: string; checks: number }>;
		incidentsTotal: number;
		incidentsThisWeek: number;
	};
	alerting: {
		channelsTotal: number;
		channelsByType: Record<string, number>;
		escalationPolicies: number;
		testAlerts: number;
		delivered90d: number;
		failed90d: number;
	};
	dependencies: number;
};

async function total(pb: PocketBase, coll: string, filter?: string): Promise<number> {
	const res = await pb.collection(coll).getList(1, 1, filter ? { filter } : {});
	return res.totalItems;
}

async function collect(pb: PocketBase): Promise<UsageStats> {
	const now = new Date();
	const weekAgo = pbDate(new Date(now.getTime() - 7 * 24 * 60 * 60_000));
	const monthAgo = pbDate(new Date(now.getTime() - 30 * 24 * 60 * 60_000));
	const dayRollupsSince = pbDate(new Date(now.getTime() - 14 * 24 * 60 * 60_000));

	// Bounded pulls (small) for the metrics that need distinct/group, not just a count.
	const [
		usersTotal,
		usersVerified,
		usersWeek,
		usersMonth,
		monitorsTotal,
		monitorsActive,
		monitorsWeek,
		enabledMonitorOwners,
		channelRows,
		escalationPolicies,
		testAlerts,
		incidentsTotal,
		incidentsWeek,
		delivered90d,
		failed90d,
		dependencies,
		dayRollups
	] = await Promise.all([
		total(pb, 'users'),
		total(pb, 'users', 'verified = true'),
		total(pb, 'users', `created >= "${weekAgo}"`),
		total(pb, 'users', `created >= "${monthAgo}"`),
		total(pb, 'monitors'),
		total(pb, 'monitors', 'enabled = true'),
		total(pb, 'monitors', `created >= "${weekAgo}"`),
		pb.collection('monitors').getFullList({ filter: 'enabled = true', fields: 'user' }),
		pb.collection('alert_channels').getFullList({ fields: 'user,type' }),
		total(pb, 'escalation_policies'),
		total(pb, 'test_alerts'),
		total(pb, 'incidents'),
		total(pb, 'incidents', `started_at >= "${weekAgo}"`),
		total(
			pb,
			'channel_events',
			`outcome = "delivered" && created >= "${pbDate(new Date(now.getTime() - 90 * 24 * 60 * 60_000))}"`
		),
		total(
			pb,
			'channel_events',
			`outcome = "failed" && created >= "${pbDate(new Date(now.getTime() - 90 * 24 * 60 * 60_000))}"`
		),
		total(pb, 'dependencies'),
		pb.collection('rollups').getFullList({
			filter: `period = "day" && bucket_start >= "${dayRollupsSince}"`,
			fields: 'bucket_start,check_count'
		})
	]);

	return {
		generatedAt: now.toISOString(),
		users: {
			total: usersTotal,
			verified: usersVerified,
			newThisWeek: usersWeek,
			newThisMonth: usersMonth
		},
		monitors: {
			total: monitorsTotal,
			active: monitorsActive,
			paused: monitorsTotal - monitorsActive,
			newThisWeek: monitorsWeek
		},
		activeUsers: distinctCount(enabledMonitorOwners as any[], 'user'),
		usersWithChannel: distinctCount(channelRows as any[], 'user'),
		activity: {
			checksPerDay: checksPerDay(dayRollups as any[]),
			incidentsTotal,
			incidentsThisWeek: incidentsWeek
		},
		alerting: {
			channelsTotal: (channelRows as any[]).length,
			channelsByType: countBy(channelRows as any[], 'type'),
			escalationPolicies,
			testAlerts,
			delivered90d,
			failed90d
		},
		dependencies
	};
}

// Server-side cache — a polling admin page shouldn't re-run ~17 count queries on
// every refresh; PocketHost applies a per-IP request cap.
let cache: { at: number; data: UsageStats } | null = null;
const TTL_MS = 60_000;

export async function getUsageStats(pb: PocketBase): Promise<UsageStats> {
	if (cache && Date.now() - cache.at < TTL_MS) return cache.data;
	const data = await collect(pb);
	cache = { at: Date.now(), data };
	return data;
}

// The fleet-operations view re-homed from the user dashboard (#248): full per-zone
// ops detail (queue depth, schedule lag, node id, heartbeat) — admin-only. Unlike
// the user-facing getZoneStats, this intentionally keeps the operational fields.
export type FleetZone = {
	zone: string;
	isEvaluator: boolean;
	queueDepth: number;
	scheduleLagSeconds: number;
	/** Live workers in the zone (#311) — a count, not names: which containers
	 *  answered is not information an operator can act on. Published by whichever
	 *  worker holds the seed lock, from the zone's shared heartbeat set. */
	workers: number;
	worker: string;
	updated: string;
	healthy: boolean;
};

export async function getFleetOps(pb: PocketBase): Promise<FleetZone[]> {
	const rows = await pb.collection('zone_stats').getFullList({ sort: 'zone' });
	return rows.map((z: Record<string, unknown>) => ({
		zone: z.zone as string,
		isEvaluator: z.zone === EVALUATOR_ZONE,
		queueDepth: (z.queue_depth as number) ?? 0,
		scheduleLagSeconds: (z.schedule_lag_seconds as number) ?? 0,
		// Absent on a zone whose worker predates #311; 0 would read as "none live",
		// so fall back to 1 — an unscaled zone is exactly one worker.
		workers: (z.workers as number) ?? 1,
		worker: (z.worker as string) ?? '',
		updated: z.updated as string,
		healthy: !isStale(z.updated as string)
	}));
}
