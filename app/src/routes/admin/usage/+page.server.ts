import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { env } from '$env/dynamic/private';
import { isAdmin } from '$lib/server/admin';
import { serviceClient } from '$lib/server/service-pb';
import { getUsageStats, getFleetOps } from '$lib/server/admin-usage';

export const load: PageServerLoad = async ({ locals }) => {
	// Server-side gate: logged-out OR non-admin → 404 (not 403), so the route
	// isn't even discoverable. A hidden nav link is not the gate.
	if (!locals.user || !isAdmin(locals.user.email, env.ADMIN_EMAILS)) {
		throw error(404, 'Not found');
	}

	// Aggregates across all users — needs the widened service-account read access,
	// not the logged-in user's owner-scoped client.
	const pb = await serviceClient();
	const [usage, fleet] = await Promise.all([getUsageStats(pb), getFleetOps(pb)]);
	return { usage, fleet };
};
