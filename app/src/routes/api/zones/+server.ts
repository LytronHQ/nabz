import type { RequestHandler } from '@sveltejs/kit';
import { failIfNoUser } from '#lib/utils/api-utils.js';
import { getApiErrors } from '#lib/utils/action-utils.js';
import { EVALUATOR_ZONE, WEB_ZONE } from '#lib/server/health.js';

// Distinct zone names that have reported stats, so the UI can offer them when
// assigning a monitor to zones. An empty selection means "all zones".
export const GET: RequestHandler = async ({ locals }) => {
	failIfNoUser(locals);

	try {
		const res = await locals.pb?.collection('zone_stats').getList(1, 100, { sort: 'zone' });
		const zones = [
			...new Set(
				(res?.items ?? [])
					.map((z) => z.zone)
					// Reserved liveness rows, not probe regions — see health.ts.
					.filter((z) => z && z !== EVALUATOR_ZONE && z !== WEB_ZONE)
			)
		];
		return Response.json({ zones });
	} catch (err) {
		return Response.json(getApiErrors(err, 'Error getting zones'), { status: 500 });
	}
};
