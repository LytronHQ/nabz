// Fleet-health aggregation for the public /api/health endpoint.
//
// The web is the only internet-facing node, so it's the single public place to
// ask "is nabz healthy?". It aggregates from PocketBase alone (so it works even
// when the web runs on Netlify and can't reach the private worker/evaluator
// nodes): PocketBase reachability + each worker zone's heartbeat freshness + the
// evaluator's heartbeat freshness.
//
// Two tiers, mirroring the node health endpoints (#103): a PUBLIC body of just
// ok/degraded (+ the names of unhealthy nodes), and a token-gated DEBUG body that
// adds a generic label + cause + staleness — never a target, credential, or raw
// error. The vocabulary here is the whole surface; nothing sensitive can leak.

// The reserved zone_stats row the evaluator writes as its own heartbeat. MUST
// match corelib's pb.EvaluatorZone. It's filtered out of the zone pickers.
export const EVALUATOR_ZONE = 'evaluator';

// The reserved row the WEB writes on a Cron Trigger, proving the check-in path
// (Worker -> edge -> Access -> Tunnel -> PocketBase) is intact (#339). MUST match
// corelib's pb.WebZone. Also filtered out of the zone pickers.
//
// Its value is not "is the website up" — the request you are reading this
// response from already proved that. It is "can the web still WRITE to
// PocketBase", which is what a heartbeat check-in needs and what nothing else
// observes: the workers and the evaluator reach PocketBase privately and stay
// healthy through an outage of this path.
export const WEB_ZONE = 'web';

export type NodeStatus = 'ok' | 'unreachable' | 'stale';
export type ItemKind = 'pocketbase' | 'evaluator' | 'zone' | 'web';

export type Item = {
	name: string;
	kind: ItemKind;
	status: NodeStatus;
	staleForMs?: number;
	// Raw PocketBase timestamp of this node's last heartbeat, when it has one
	// (zones + evaluator; PocketBase itself has none). Surfaced on the debug tier
	// as an absolute "since when it was last seen".
	lastSeen?: string;
};

export type ZoneRow = { zone: string; updated: string };

// Parse a PocketBase timestamp ("2006-01-02 15:04:05.000Z") to epoch ms, or null.
export function parsePbTime(s: string | undefined): number | null {
	if (!s) return null;
	const t = Date.parse(s.replace(' ', 'T'));
	return Number.isNaN(t) ? null : t;
}

function freshness(
	updated: string | undefined,
	now: number,
	staleMs: number
): { stale: boolean; ageMs: number | null } {
	const t = parsePbTime(updated);
	if (t == null) return { stale: true, ageMs: null };
	const ageMs = now - t;
	return { stale: ageMs > staleMs, ageMs };
}

// Build the health items from the raw inputs. Pure — the route supplies PB
// reachability + the zone_stats rows; this decides the rest.
export function buildItems(opts: {
	pbReachable: boolean;
	rows: ZoneRow[];
	now: number;
	staleMs: number;
	/** The web beat is a CRON firing every 2 minutes, so it cannot share the
	 *  window used for zone heartbeats that beat every 10s: a punctual beat would
	 *  read as stale for the last 30s of each cycle and the endpoint would report
	 *  degraded a quarter of the time on a healthy fleet. Defaults to staleMs so
	 *  existing callers are unchanged. */
	webStaleMs?: number;
}): Item[] {
	const items: Item[] = [
		{ name: 'pocketbase', kind: 'pocketbase', status: opts.pbReachable ? 'ok' : 'unreachable' }
	];
	// Without PocketBase there's nothing to aggregate — report just that.
	if (!opts.pbReachable) return items;

	const evalRow = opts.rows.find((r) => r.zone === EVALUATOR_ZONE);
	// A missing evaluator row means it has never heartbeat (dead or never started).
	const ef = freshness(evalRow?.updated, opts.now, opts.staleMs);
	items.push({
		name: 'evaluator',
		kind: 'evaluator',
		status: ef.stale ? 'stale' : 'ok',
		staleForMs: ef.stale && ef.ageMs != null ? ef.ageMs : undefined,
		lastSeen: evalRow?.updated
	});

	// Only reported once the beat has run at least once. Absent means the Cron
	// Trigger is not deployed, not that the path is broken — and the evaluator
	// makes the same distinction (checkInPathDown returns seen=false), so an
	// environment without the cron keeps alerting normally instead of showing
	// degraded forever. A row that exists and has gone stale IS the signal.
	const webRow = opts.rows.find((r) => r.zone === WEB_ZONE);
	if (webRow) {
		const wf = freshness(webRow.updated, opts.now, opts.webStaleMs ?? opts.staleMs);
		items.push({
			name: 'web',
			kind: 'web',
			status: wf.stale ? 'stale' : 'ok',
			staleForMs: wf.stale && wf.ageMs != null ? wf.ageMs : undefined,
			lastSeen: webRow.updated
		});
	}

	for (const r of opts.rows.filter((r) => r.zone !== EVALUATOR_ZONE && r.zone !== WEB_ZONE)) {
		const zf = freshness(r.updated, opts.now, opts.staleMs);
		items.push({
			name: r.zone,
			kind: 'zone',
			status: zf.stale ? 'stale' : 'ok',
			staleForMs: zf.stale && zf.ageMs != null ? zf.ageMs : undefined,
			lastSeen: r.updated
		});
	}
	return items;
}

export function overallStatus(items: Item[]): 'ok' | 'degraded' {
	return items.every((i) => i.status === 'ok') ? 'ok' : 'degraded';
}

// --- wire formats (only these fields are ever emitted) ---

// Generic, static causes — WHAT is wrong, never WITH WHAT.
function cause(status: NodeStatus): string | undefined {
	switch (status) {
		case 'unreachable':
			return 'did not respond to a health probe';
		case 'stale':
			return 'no recent heartbeat within the staleness window';
		default:
			return undefined;
	}
}

function humanDuration(ms: number): string {
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	const rem = s % 60;
	return rem ? `${m}m${rem}s` : `${m}m`;
}

export type PublicBody = { status: 'ok' | 'degraded'; unhealthy?: string[] };

export function publicBody(items: Item[]): PublicBody {
	const status = overallStatus(items);
	const body: PublicBody = { status };
	const unhealthy = items.filter((i) => i.status !== 'ok').map((i) => i.name);
	if (unhealthy.length) body.unhealthy = unhealthy;
	return body;
}

export type DebugItem = {
	name: string;
	status: NodeStatus;
	cause?: string;
	stale_for?: string;
	last_seen?: string;
};
export type DebugBody = { status: 'ok' | 'degraded'; items: DebugItem[] };

export function debugBody(items: Item[]): DebugBody {
	return {
		status: overallStatus(items),
		items: items.map((i) => {
			const di: DebugItem = { name: i.name, status: i.status };
			const c = cause(i.status);
			if (c) di.cause = c;
			// stale_for = relative (how long silent); last_seen = the absolute
			// moment of the last heartbeat, so you can pin exactly when it went bad.
			if (i.staleForMs != null) di.stale_for = humanDuration(i.staleForMs);
			if (i.lastSeen) di.last_seen = i.lastSeen;
			return di;
		})
	};
}
