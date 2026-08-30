import type { LayoutServerLoad } from './$types';
import { env } from '$env/dynamic/private';
import { isAdmin } from '$lib/server/admin';

export const load: LayoutServerLoad = async ({ locals }) => {
	return {
		user: locals.user,
		// Drives the admin-only nav link. The /admin routes gate server-side
		// regardless — this just decides whether to show the link.
		isAdmin: isAdmin(locals.user?.email, env.ADMIN_EMAILS)
	};
};
