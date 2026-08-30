import PocketBase from 'pocketbase';
import { env } from '$env/dynamic/private';

// The single place a PocketBase client is constructed (#338).
//
// In production PocketBase has NO public inbound port: the worker and evaluator
// reach it over the Hetzner private network, and this app — which runs on
// Cloudflare Workers and cannot route to a private IP — reaches it through a
// Cloudflare Tunnel behind Access. Access only lets a request through if it
// carries a service token, so every request this app makes has to be signed.
//
// The invariant is "PocketBase is reachable only by an authenticated Worker,
// with no exceptions" — which is why there is no Access bypass for file
// downloads and why avatars are proxied through /api/avatar instead.
//
// Note for anyone adding a `fetch` to PocketBase that does NOT go through the
// SDK: it needs these headers too, or Access rejects it.

/** Headers that authenticate this Worker to Cloudflare Access. Empty when no
 * service token is configured (dev, or a self-hosted web VM reaching PB
 * directly) — Access simply isn't in the path there. */
export function accessHeaders(): Record<string, string> {
	const id = env.CF_ACCESS_CLIENT_ID;
	const secret = env.CF_ACCESS_CLIENT_SECRET;
	if (!id || !secret) return {};
	return { 'CF-Access-Client-Id': id, 'CF-Access-Client-Secret': secret };
}

/** A PocketBase client pointed at PB_URL, carrying the Access service token and
 * with auto-cancellation off. Auto-cancellation has to stay off server-side:
 * we fire several queries against the same collection in parallel (the
 * dashboard's per-status counts, /admin/usage aggregation), and the SDK would
 * otherwise abort them as "duplicates". */
export function createPocketBase(): PocketBase {
	const pb = new PocketBase(env.PB_URL);
	pb.autoCancellation(false);

	const headers = accessHeaders();
	if (Object.keys(headers).length > 0) {
		pb.beforeSend = (url, options) => {
			options.headers = { ...options.headers, ...headers };
			return { url, options };
		};
	}
	return pb;
}
