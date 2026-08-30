import PocketBase from 'pocketbase';
import { env } from '$env/dynamic/private';
import { createPocketBase } from '$lib/server/pb-client';

// A server-side PocketBase client authenticated as the web service account, for
// public endpoints that must read data without a logged-in user (e.g. the public
// /api/health, which reads zone_stats). Cached and re-authed when the token
// lapses. Mirrors the service-account auth the /ping endpoint uses.
let client: PocketBase | null = null;

export async function serviceClient(): Promise<PocketBase> {
	if (!env.PB_URL || !env.WEB_PB_USERNAME || !env.WEB_PB_PASSWORD) {
		throw new Error('web service-account PocketBase credentials are not configured');
	}
	if (client?.authStore.isValid) return client;
	client = createPocketBase();
	await client
		.collection(env.WEB_PB_COLLECTION || 'service_accounts')
		.authWithPassword(env.WEB_PB_USERNAME, env.WEB_PB_PASSWORD);
	return client;
}
