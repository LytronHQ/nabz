import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { MonitorItem } from '$lib/models/monitor';
import { computeUptime24h, fetchRecentChecks } from '$lib/server/checks';
import { getOpenIncidentForMonitor } from '$lib/server/incidents';
import { getAvailabilityTable, getAvailabilityOverview } from '$lib/server/availability';

export const load: PageServerLoad = async ({ locals, params }) => {
	if (!locals.user) {
		throw redirect(303, '/signin');
	}

	let record;
	try {
		record = await locals.pb!.collection('monitors').getOne(params.id, {
			filter: `user="${locals.user.id}"`
		});
	} catch {
		throw error(404, 'Monitor not found');
	}

	const [uptime24h, checks, openIncident, availability, availabilityOverview] = await Promise.all([
		computeUptime24h(locals.pb!, record.id),
		fetchRecentChecks(locals.pb!, record.id, 24),
		getOpenIncidentForMonitor(locals.pb!, record.id),
		getAvailabilityTable(locals.pb!, record.id),
		getAvailabilityOverview(locals.pb!, record.id)
	]);

	const monitor = new MonitorItem({ ...record, uptime24h });

	return {
		monitor: { ...monitor },
		openIncident,
		availability,
		availabilityOverview,
		checks: checks.map((c) => ({
			checked_at: c.checked_at,
			response_ms: c.response_ms,
			dns_ms: c.dns_ms,
			connect_ms: c.connect_ms,
			tls_ms: c.tls_ms,
			ttfb_ms: c.ttfb_ms,
			up: c.up,
			status_code: c.status_code,
			zone: c.zone,
			error: c.error,
			redirect_count: c.redirect_count ?? 0,
			final_url: c.final_url ?? ''
		}))
	};
};
