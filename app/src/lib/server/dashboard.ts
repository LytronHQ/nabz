import type PocketBase from 'pocketbase';
import { getZones, fallbackZone } from '$lib/server/zones';
import { MonitorStatuses } from '$lib/models/monitor';
import { EVALUATOR_ZONE, WEB_ZONE } from '$lib/server/health';
import { isStale } from '$lib/utils/format-utils';

function pbDate(d: Date): string {
	return d.toISOString().replace('T', ' ');
}

function median(nums: number[]): number | null {
	if (!nums.length) return null;
	const s = [...nums].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

export type StatusCounts = { total: number } & Record<string, number>;

export type MonitorOverview = {
	id: string;
	name: string;
	type: string;
	target: string;
	status: string;
	lastChecked: string | null;
	p50: number | null;
	sparkline: number[];
};

export type DashboardOverview = {
	monitors: MonitorOverview[];
	statusCounts: StatusCounts;
	avgLatency: number | null;
	/** Scheduling terms for the checks/min tile — see scheduledCheckRate (#324).
	 *  Split because a monitor with no assigned zone runs in EVERY zone, so its
	 *  contribution is not known until the zone list is. `interval` and `zones`
	 *  stay server-side; they are not display fields and would only bloat the
	 *  payload of a page that polls. */
	schedule: { perMinuteFixed: number; perMinutePerZone: number };
};

/**
 * Monitors + per-status counts + per-monitor recent latency/sparkline + fleet p50,
 * in TWO queries (monitors, then a single recent-checks pull scoped to the user by
 * the `checks` list rule). Keeps the polling dashboard's request count bounded.
 */
export async function getMonitorsOverview(
	pb: PocketBase,
	userId: string
): Promise<DashboardOverview> {
	const mons = await pb
		.collection('monitors')
		.getFullList({ filter: `user="${userId}"`, sort: 'name' });

	// Disabled monitors aren't scheduled, so their stored status is stale — treat
	// them as "paused" (matches MonitorItem's derivation on the client).
	const effStatus = (m: any) => (m.enabled === false ? 'paused' : (m.status ?? 'pending'));

	const counts: StatusCounts = { total: mons.length } as StatusCounts;
	for (const s of MonitorStatuses) counts[s] = 0;
	for (const m of mons) counts[effStatus(m)] = (counts[effStatus(m)] ?? 0) + 1;

	// one pull of recent checks (last 90m), newest-first, grouped by monitor
	const since = pbDate(new Date(Date.now() - 90 * 60_000));
	const checks = await pb.collection('checks').getList(1, 800, {
		filter: `checked_at >= "${since}"`,
		sort: '-checked_at',
		fields: 'monitor,up,response_ms,checked_at'
	});
	const byMon = new Map<string, any[]>();
	for (const c of checks.items) {
		const arr = byMon.get(c.monitor) ?? [];
		arr.push(c);
		byMon.set(c.monitor, arr);
	}

	const fleetLat: number[] = [];
	const monitors: MonitorOverview[] = mons.map((m) => {
		const cs = byMon.get(m.id) ?? []; // newest-first
		const ups = cs.filter((c) => c.up && c.response_ms != null).map((c) => c.response_ms as number);
		fleetLat.push(...ups);
		const series = cs
			.slice(0, 40)
			.reverse()
			.map((c) => (c.response_ms ?? 0) as number); // oldest→newest
		return {
			id: m.id,
			name: m.name,
			type: m.type,
			target: m.target,
			status: effStatus(m),
			lastChecked: m.last_checked ?? null,
			p50: median(ups),
			sparkline: series
		};
	});

	let perMinuteFixed = 0;
	let perMinutePerZone = 0;
	for (const m of mons) {
		if (m.enabled === false) continue;
		const interval = Number(m.interval) || 0;
		if (interval <= 0) continue;
		const assigned = Array.isArray(m.zones) ? m.zones.filter(Boolean).length : 0;
		if (assigned > 0) perMinuteFixed += (assigned * 60) / interval;
		else perMinutePerZone += 60 / interval;
	}

	return {
		monitors,
		statusCounts: counts,
		avgLatency: median(fleetLat),
		schedule: { perMinuteFixed, perMinutePerZone }
	};
}

/**
 * Fleet uptime over the last 24h, from the HOUR rollup tier plus the in-flight
 * hour from raw checks (#324).
 *
 * This used to be two `COUNT(*)` over a 24-hour window of `checks`. They were not
 * unindexed — `idx_checks_checked_at` exists — the cost is that the `checks` list
 * rule joins every candidate row back to `monitors` to authorise it, over a window
 * holding 2,880 rows per monitor. Test B measured the dashboard at a 3.3s p50
 * under load, and it is reads, not writes, that cap usable fleet size.
 *
 * The weighting is the one `aggregateRollups` already uses, so this is
 * arithmetically identical to the raw count, not an approximation:
 *
 *     Σ(uptime_pct / 100 × check_count) / Σ(check_count)
 *
 * Rollups only close on the hour, so the newest complete bucket can be up to 60
 * minutes old. Rather than label the tile "last 24 complete hours" and quietly
 * ignore the most recent hour — the hour a user is most likely to be looking at —
 * the partial hour is backfilled from raw `checks`. That read is bounded to ≤1
 * hour of rows: 1/24th of what this function used to scan.
 */
export async function getFleetUptime24h(pb: PocketBase): Promise<number | null> {
	const now = Date.now();
	const hourStart = Math.floor(now / 3_600_000) * 3_600_000;
	const since = pbDate(new Date(now - 24 * 60 * 60_000));

	let weighted = 0;
	let counted = 0;

	try {
		const rollups = await pb.collection('rollups').getFullList({
			filter: `period = "hour" && bucket_start >= "${since}"`,
			fields: 'uptime_pct,check_count'
		});
		for (const r of rollups) {
			const n = Number(r.check_count) || 0;
			if (n <= 0) continue;
			weighted += ((Number(r.uptime_pct) || 0) / 100) * n;
			counted += n;
		}
	} catch (err) {
		// Degrade to the partial-hour figure rather than failing the dashboard.
		console.warn('getFleetUptime24h: rollup read failed:', err);
	}

	// The in-flight hour, which no bucket covers yet.
	const partial = await pb.collection('checks').getList(1, 1, {
		filter: `checked_at >= "${pbDate(new Date(hourStart))}"`
	});
	if (partial.totalItems > 0) {
		const up = await pb.collection('checks').getList(1, 1, {
			filter: `checked_at >= "${pbDate(new Date(hourStart))}" && up=true`
		});
		weighted += up.totalItems;
		counted += partial.totalItems;
	}

	if (counted === 0) return null;
	return Math.round((weighted / counted) * 10000) / 100;
}

/**
 * The rate the fleet is SCHEDULED to check at, derived from configuration:
 *
 *     Σ over enabled monitors of ( zones × 60 / interval )
 *
 * Free — `monitors` is already loaded by getMonitorsOverview — exact, and it
 * touches `checks` not at all. It replaces a `COUNT(*)` over a 60-second window,
 * the third unbounded count on this page.
 *
 * `scheduled` is a promise, not an observation: it stays exactly the same while
 * every worker is dead. On a product whose job is detecting failure, a number that
 * reads healthy through a total outage is worse than no number, so it is paired
 * with `fleetLive` and the tile must not render it as a healthy figure when that
 * is false. Labelling alone would not do: a correctly-labelled number in a row of
 * stat tiles still reads as throughput at a glance.
 *
 * Liveness comes from the zone heartbeats, which workers upsert every loop and
 * `isStale` judges at 30 seconds — 60–120× faster at catching a total outage than
 * anything derivable from the hourly tier, whose newest complete bucket describes
 * a window that ended up to an hour ago.
 */
export type ScheduledRate = { perMinute: number; fleetLive: boolean };

export function scheduledCheckRate(
	schedule: { perMinuteFixed: number; perMinutePerZone: number },
	zones: ZoneStat[]
): ScheduledRate {
	// A monitor with no assigned zone runs in every zone, so its term scales with
	// the zone count. Floor of 1 so a fresh instance reports its own schedule
	// rather than zero.
	const perMinute = schedule.perMinuteFixed + schedule.perMinutePerZone * Math.max(zones.length, 1);
	// Unknown (no zones reporting at all) counts as not live: the tile should not
	// claim a healthy rate on an instance that has never seen a worker.
	const fleetLive = zones.length > 0 && zones.every((z) => z.healthy);
	return { perMinute: Math.round(perMinute * 10) / 10, fleetLive };
}

export type OpenIncident = {
	id: string;
	monitorId: string;
	monitor: string;
	cause: string;
	started_at: string;
};

/** Currently-open incidents (unresolved), newest first. A summary widget — degrade
 *  to empty rather than failing the whole dashboard if the filter is rejected. */
export async function getOpenIncidents(pb: PocketBase): Promise<OpenIncident[]> {
	try {
		const r = await pb.collection('incidents').getList(1, 20, {
			filter: `resolved_at = ""`,
			sort: '-started_at',
			expand: 'monitor'
		});
		return r.items.map((i) => ({
			id: i.id,
			monitorId: i.monitor,
			monitor: i.expand?.monitor?.name ?? '(deleted monitor)',
			cause: i.cause ?? '',
			started_at: i.started_at
		}));
	} catch (err) {
		console.warn('getOpenIncidents failed:', err);
		return [];
	}
}

// User-facing zone shape: the region name and a healthy/unhealthy indicator —
// nothing operational. Queue depth, schedule lag, the worker/node id and raw
// heartbeat timing are deliberately NOT shipped to the dashboard (#248); they're
// internal architecture detail that belongs on the admin/usage view (#246), the
// same way the public health tier hides internals behind a gated debug tier
// (#103). Staleness still *drives* `healthy`, it just isn't exposed as a number.
export type ZoneStat = {
	/** The zone CODE. Kept alongside the label because it is what monitors are
	 *  pinned to and what appears in logs. */
	zone: string;
	/** What to show a user. Falls back to the code (#311). */
	label: string;
	healthy: boolean;
};

/** Per-zone health for the user dashboard — the reserved evaluator heartbeat row
 * is excluded (it isn't a worker zone). Only `zone`/`updated` are fetched, and
 * `updated` is collapsed to a boolean here so no timing/ops fields ever reach the
 * page payload. */
export async function getZoneStats(pb: PocketBase): Promise<ZoneStat[]> {
	const [r, zones] = await Promise.all([
		pb.collection('zone_stats').getList(1, 50, { sort: 'zone', fields: 'zone,updated' }),
		// Labels only — the rows shown are still the zones actually reporting, so
		// a named-but-dead zone cannot appear here either (#328).
		getZones(pb)
	]);
	return r.items
		.filter((z) => z.zone !== EVALUATOR_ZONE && z.zone !== WEB_ZONE)
		.map((z) => {
			const code = z.zone as string;
			const label = zones.get(code) ?? fallbackZone(code);
			return { zone: code, label: label.displayName, sortOrder: label.sortOrder, healthy: !isStale(z.updated as string) };
		})
		.sort((a, b) => a.sortOrder - b.sortOrder || a.zone.localeCompare(b.zone))
		.map(({ zone, label, healthy }) => ({ zone, label, healthy }));
}
