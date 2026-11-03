import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { MonitorItem } from '#lib/models/monitor.js';
import { computeUptime24h, fetchRecentChecks } from '#lib/server/checks.js';
import { getOpenIncidentForMonitor } from '#lib/server/incidents.js';
import { getAvailabilityTable, getAvailabilityOverview } from '#lib/server/availability.js';
import { getZones } from '#lib/server/zones.js';
import type { ZoneLabel } from '#lib/utils/zone-order.js';
import { getAccountPlan } from '#lib/server/plan.js';
import { historyMessage, historyStart } from '#lib/plans.js';

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

	// How far back this account's plan shows history (#703).
	const { plan } = await getAccountPlan(locals.pb!, locals.user);
	const [uptime24h, checks, openIncident, availability, availabilityOverview, zones] =
		await Promise.all([
			computeUptime24h(locals.pb!, record.id),
			fetchRecentChecks(locals.pb!, record.id, 24),
			getOpenIncidentForMonitor(locals.pb!, record.id),
			getAvailabilityTable(locals.pb!, record.id, new Date(), plan.historyDays),
			getAvailabilityOverview(locals.pb!, record.id),
			// Names and order for the zones this page shows, as the form and the
			// dashboard have them (#558).
			getZones(locals.pb!)
		]);
	const zoneLabels: Record<string, ZoneLabel> = Object.fromEntries(
		[...zones].map(([code, z]) => [code, { label: z.displayName, sortOrder: z.sortOrder }])
	);

	const monitor = new MonitorItem({ ...record, uptime24h });

	return {
		monitor: { ...monitor },
		openIncident,
		availability,
		availabilityOverview,
		history: (() => {
			const start = historyStart(plan);
			return {
				// YYYY-MM-DD, the custom range's earliest From date; null = no limit.
				start: start ? start.toISOString().slice(0, 10) : null,
				message: start ? historyMessage(plan) : ''
			};
		})(),
		zoneLabels,
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
			inconclusive: !!c.inconclusive,
			redirect_count: c.redirect_count ?? 0,
			final_url: c.final_url ?? ''
		}))
	};
};
