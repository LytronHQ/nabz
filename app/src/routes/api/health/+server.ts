import { json, type RequestHandler } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { timingSafeEqual } from 'node:crypto';
import { serviceClient } from '$lib/server/service-pb';
import { accessHeaders } from '$lib/server/pb-client';
import { buildItems, overallStatus, publicBody, debugBody, type ZoneRow } from '$lib/server/health';

// Public fleet-health endpoint (Option 1 of the web-health design). Aggregates
// from PocketBase only — so it works even when the web is on Netlify and can't
// reach the private nodes: PB reachability + worker-zone heartbeats + the
// evaluator's self-heartbeat. Two-tier like the node endpoints (#103): a minimal
// public body, and a token-gated scrubbed debug body.
//
// No user auth — it must be pollable by an external uptime monitor. Reads
// zone_stats via the web service account.

const STALE_MS = (Number(env.HEALTH_STALE_SECONDS) || 90) * 1000;
// The web liveness beat is a 2-minute cron (wrangler.toml [triggers]), so it is
// judged on its own clock — 5 minutes, the window that file already documents,
// which also survives one missed run. Sharing HEALTH_STALE_SECONDS made a healthy
// deployment report degraded for part of every cycle.
const WEB_STALE_MS = (Number(env.WEB_BEAT_STALE_SECONDS) || 300) * 1000;

async function pbReachable(): Promise<boolean> {
	if (!env.PB_URL) return false;
	try {
		// Access headers, exactly as pb-client warns: a raw fetch to PocketBase that
		// skips the SDK still has to authenticate to Cloudflare Access, or it gets a
		// 403 and this reports "unreachable" for a PocketBase that is perfectly
		// healthy — permanently, since the condition never clears. Empty in dev,
		// where Access is not in the path.
		const res = await fetch(`${env.PB_URL}/api/health`, {
			headers: accessHeaders(),
			signal: AbortSignal.timeout(4000)
		});
		return res.ok;
	} catch {
		return false;
	}
}

async function readZoneRows(): Promise<ZoneRow[]> {
	const pb = await serviceClient();
	const rows = await pb.collection('zone_stats').getFullList({ fields: 'zone,updated' });
	return rows.map((r: Record<string, unknown>) => ({
		zone: String(r.zone),
		updated: String(r.updated)
	}));
}

// Constant-time bearer-token check. A blank configured token is never authorized;
// a missing/wrong token silently falls back to the public body (no 401, no hint).
function authorized(request: Request): boolean {
	const token = env.HEALTH_DEBUG_TOKEN;
	if (!token) return false;
	const header = request.headers.get('authorization') ?? '';
	const prefix = 'Bearer ';
	if (!header.startsWith(prefix)) return false;
	const provided = Buffer.from(header.slice(prefix.length));
	const expected = Buffer.from(token);
	if (provided.length !== expected.length) return false;
	return timingSafeEqual(provided, expected);
}

export const GET: RequestHandler = async ({ request }) => {
	let reachable = await pbReachable();
	let rows: ZoneRow[] = [];
	if (reachable) {
		try {
			rows = await readZoneRows();
		} catch {
			// PB answered its health check but we couldn't read the fleet state
			// (auth/config problem). Report conservatively as unreachable rather
			// than claim a falsely-healthy fleet.
			reachable = false;
		}
	}

	const items = buildItems({
		pbReachable: reachable,
		rows,
		now: Date.now(),
		staleMs: STALE_MS,
		webStaleMs: WEB_STALE_MS
	});
	const code = overallStatus(items) === 'degraded' ? 503 : 200;
	const body = authorized(request) ? debugBody(items) : publicBody(items);
	return json(body, { status: code });
};
