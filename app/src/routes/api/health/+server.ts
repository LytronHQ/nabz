import type { RequestHandler } from '@sveltejs/kit';

import {
	HEALTH_STALE_SECONDS,
	WEB_BEAT_STALE_SECONDS,
	PB_URL,
	HEALTH_DEBUG_TOKEN
} from '$app/env/private';

import { timingSafeEqual } from 'node:crypto';
import { serviceClient } from '#lib/server/service-pb.js';
import { accessHeaders } from '#lib/server/pb-client.js';
import {
	buildItems,
	overallStatus,
	publicBody,
	debugBody,
	staleLimits,
	type ZoneRow
} from '#lib/server/health.js';
import { APP_VERSION, APP_COMMIT } from '#lib/version.js';

// Public fleet-health endpoint (Option 1 of the web-health design). Aggregates
// from PocketBase only — so it works even when the web is on Netlify and can't
// reach the private nodes: PB reachability + worker-zone heartbeats + the
// evaluator's self-heartbeat. Two-tier like the node endpoints (#103): a minimal
// public body, and a token-gated scrubbed debug body.
//
// No user auth — it must be pollable by an external uptime monitor. Reads
// zone_stats via the web service account.

const { staleMs: STALE_MS, webStaleMs: WEB_STALE_MS } = staleLimits({
	HEALTH_STALE_SECONDS,
	WEB_BEAT_STALE_SECONDS
});

async function pbReachable(): Promise<boolean> {
	if (!PB_URL) return false;
	try {
		// Access headers, exactly as pb-client warns: a raw fetch to PocketBase that
		// skips the SDK still has to authenticate to Cloudflare Access, or it gets a
		// 403 and this reports "unreachable" for a PocketBase that is perfectly
		// healthy — permanently, since the condition never clears. Empty in dev,
		// where Access is not in the path.
		const res = await fetch(`${PB_URL}/api/health`, {
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
	const token = HEALTH_DEBUG_TOKEN;
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
	// The version answers "is the build I just deployed the one serving?" (#489).
	return Response.json({ ...body, version: APP_VERSION, commit: APP_COMMIT }, { status: code });
};
