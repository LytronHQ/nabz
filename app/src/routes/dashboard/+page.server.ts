import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import {
	getMonitorsOverview,
	getFleetUptime24h,
	scheduledCheckRate,
	getZoneStats,
	getOpenIncidents
} from '$lib/server/dashboard';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) {
		throw redirect(303, '/signin');
	}

	const [overview, fleetUptime, zones, openIncidents] = await Promise.all([
		getMonitorsOverview(locals.pb!, locals.user.id),
		getFleetUptime24h(locals.pb!),
		getZoneStats(locals.pb!),
		getOpenIncidents(locals.pb!)
	]);

	// Derived from data already loaded — no query, and no `checks` access (#324).
	const scheduled = scheduledCheckRate(overview.schedule, zones);

	return { ...overview, fleetUptime, scheduled, zones, openIncidents };
};
