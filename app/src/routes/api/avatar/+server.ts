import { error, type RequestHandler } from '@sveltejs/kit';
import { accessHeaders } from '$lib/server/pb-client';

// Serves the signed-in user's own avatar (#338).
//
// PocketBase sits behind Cloudflare Access with no public inbound port, and a
// browser cannot present a service token — so it cannot fetch
// {PB_URL}/api/files/... directly. Rather than punching an Access bypass for
// /api/files/* (a carve-out that has to stay correctly configured forever, and
// is invisible when it drifts), the file is fetched server-side here, where the
// token is available, and streamed back.
//
// Own avatar only: the two places an avatar renders — the nav and the account
// page — are both the current user's. Serving arbitrary users' files through an
// authenticated proxy would widen access beyond what the `users` collection
// rules allow.
export const GET: RequestHandler = async ({ locals, fetch }) => {
	const record = locals.pb?.authStore.record;
	const file = record?.avatar as string | undefined;
	if (!locals.pb || !record || !file) throw error(404, 'No avatar');

	const upstream = locals.pb.files.getURL(record, file);
	if (!upstream) throw error(404, 'No avatar');

	const res = await fetch(upstream, { headers: accessHeaders() });
	if (!res.ok) {
		// A 403 here almost always means the Access service token is missing or
		// expired — the same failure that would take the whole app down, so it is
		// worth naming rather than surfacing as a blank image.
		console.error(`avatar proxy: upstream returned ${res.status} for user ${record.id}`);
		throw error(res.status === 404 ? 404 : 502, 'Avatar unavailable');
	}

	return new Response(res.body, {
		headers: {
			'content-type': res.headers.get('content-type') ?? 'application/octet-stream',
			// Private: this is one user's file behind their session, so it must not
			// land in a shared cache. The URL carries the filename as a cache-buster,
			// so a new upload is a new URL and this can be cached for a while.
			'cache-control': 'private, max-age=300'
		}
	});
};
