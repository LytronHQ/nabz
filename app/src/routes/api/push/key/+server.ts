import type { RequestHandler } from '@sveltejs/kit';
import { VAPID_PUBLIC_KEY } from '$app/env/private';

// The key a browser subscribes with (#602). It is public by design, but only a
// signed-in user can add a channel, so only they need it. An empty key means
// push is not set up on this deployment; the form says so instead of failing
// inside pushManager.subscribe().
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) return new Response(null, { status: 401 });
	return Response.json({ publicKey: VAPID_PUBLIC_KEY || '' });
};
