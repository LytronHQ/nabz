import { error, json, type RequestHandler } from '@sveltejs/kit';
import PocketBase from 'pocketbase';
import { env } from '$env/dynamic/private';
import { createPocketBase } from '$lib/server/pb-client';
import { WEB_ZONE } from '$lib/server/health';

// Path-liveness beat for heartbeat monitors (#339).
//
// A heartbeat check-in is recorded by the Worker writing to PocketBase, which
// after #338 travels Worker -> Cloudflare edge -> Access -> Tunnel -> PocketBase.
// Every hop is a dependency of RECORDING a check-in, and none of them is a
// dependency of the evaluator, which sits on the private network. So when that
// path breaks, `last_checked` stops advancing, the evaluator sees silence, and it
// opens incidents and pages people for outages that are not happening.
//
// This endpoint writes a reserved `web` zone_stats row over exactly that path, on
// a Cron Trigger. Fresh row => the path works, so silence really is the
// customer's job not running. Stale row => the path is broken and every heartbeat
// verdict is untrustworthy, so the evaluator holds them.
//
// It fails safe by construction: whatever breaks a real check-in breaks this
// write too, because it is the same write. That is the whole reason for doing it
// this way rather than correlating "lots of heartbeats went quiet at once", which
// cannot tell a systemic outage from a customer whose fleet genuinely died — the
// exact case they most need paging for.

let servicePb: PocketBase | null = null;

async function pocketbase(): Promise<PocketBase> {
	if (!env.PB_URL || !env.WEB_PB_USERNAME || !env.WEB_PB_PASSWORD) {
		throw error(503, 'not configured');
	}
	if (!servicePb) servicePb = createPocketBase();
	if (!servicePb.authStore.isValid) {
		await servicePb
			.collection(env.WEB_PB_COLLECTION || 'service_accounts')
			.authWithPassword(env.WEB_PB_USERNAME, env.WEB_PB_PASSWORD);
	}
	return servicePb;
}

export const POST: RequestHandler = async ({ request }) => {
	// Reachable from the internet like any route, so it is token-gated. Reuses
	// HEALTH_DEBUG_TOKEN rather than minting another secret: same blast radius
	// (privileged observability), one fewer thing to rotate. Unset means the
	// endpoint is off, not open.
	const expected = env.HEALTH_DEBUG_TOKEN;
	if (!expected) throw error(503, 'not configured');
	if (request.headers.get('authorization') !== `Bearer ${expected}`) throw error(404, 'Not found');

	const pb = await pocketbase();

	// Same upsert shape as the workers'. queue_depth / lag are meaningless here
	// and stay 0; the `updated` timestamp is the entire signal.
	const existing = await pb
		.collection('zone_stats')
		.getList(1, 1, { filter: `zone = "${WEB_ZONE}"`, skipTotal: true });
	const body = { zone: WEB_ZONE, worker: 'web', queue_depth: 0, schedule_lag_seconds: 0 };
	if (existing.items.length > 0) {
		await pb.collection('zone_stats').update(existing.items[0].id, body);
	} else {
		await pb.collection('zone_stats').create(body);
	}

	return json({ ok: true, zone: WEB_ZONE });
};
