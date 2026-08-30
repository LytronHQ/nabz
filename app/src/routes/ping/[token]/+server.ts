import { error, text, type RequestHandler } from '@sveltejs/kit';
import PocketBase from 'pocketbase';
import { env } from '$env/dynamic/private';
import { createPocketBase } from '$lib/server/pb-client';

// A heartbeat check-in: the user's cron/job hits /ping/{token} on each run. There
// is no user session — the unguessable token IS the credential. Recording the
// check-in needs a privileged PB write, so we use a dedicated `web` service
// account. The client is cached across requests so we don't re-auth every ping.
let servicePb: PocketBase | null = null;

async function pocketbase(): Promise<PocketBase> {
	if (!env.PB_URL || !env.WEB_PB_USERNAME || !env.WEB_PB_PASSWORD) {
		throw error(503, 'Heartbeat check-in is not configured');
	}
	if (!servicePb) {
		servicePb = createPocketBase();
	}
	if (!servicePb.authStore.isValid) {
		await servicePb
			.collection(env.WEB_PB_COLLECTION || 'service_accounts')
			.authWithPassword(env.WEB_PB_USERNAME, env.WEB_PB_PASSWORD);
	}
	return servicePb;
}

async function checkIn(token: string): Promise<void> {
	if (!token) throw error(404, 'Unknown heartbeat');
	const pb = await pocketbase();

	let monitor;
	try {
		// filter(...) binds the token safely (escapes it), so a crafted URL can't
		// break out of the filter.
		monitor = await pb
			.collection('monitors')
			.getFirstListItem(
				pb.filter('token = {:token} && type = "heartbeat" && enabled = true', { token })
			);
	} catch {
		throw error(404, 'Unknown or disabled heartbeat');
	}

	const now = new Date().toISOString();
	// last_checked drives the evaluator's up/down decision and the "last check" tile.
	await pb.collection('monitors').update(monitor.id, { last_checked: now });
	// Also record the check-in as a check so the monitor shows check-in history and
	// uptime. Best-effort — the check-in already registered via last_checked above.
	try {
		await pb
			.collection('checks')
			.create({ monitor: monitor.id, zone: 'heartbeat', up: true, checked_at: now });
	} catch (err) {
		// History is best-effort — last_checked above already registered the check-in —
		// but don't swallow it silently: a failure here means lost heartbeat history (#150).
		console.error('heartbeat check-in: failed to record checks row', err);
	}
}

const handler: RequestHandler = async ({ params }) => {
	await checkIn(params.token!);
	return text('OK\n');
};

// Cron tools use various verbs; accept the common ones.
export const GET = handler;
export const POST = handler;
export const HEAD = handler;
