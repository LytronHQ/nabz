import type { LayoutServerLoad } from './$types';
import { ADMIN_EMAILS } from '$app/env/private';
import { isAdmin } from '#lib/server/admin.js';

export const load: LayoutServerLoad = async ({ locals, url }) => {
	// Read the path so SvelteKit reruns this on every navigation. Without a
	// dependency it reused its first result on client-side navigations, so when a
	// session ended under an open tab (a password reset invalidates every token)
	// the sign-in page appeared inside the signed-in shell (#633). It costs
	// nothing: locals.user is already resolved by the hook for every request.
	void url.pathname;
	return {
		user: locals.user,
		// Drives the admin-only nav link. The /admin routes gate server-side
		// regardless — this just decides whether to show the link.
		isAdmin: isAdmin(locals.user?.email, ADMIN_EMAILS)
	};
};
