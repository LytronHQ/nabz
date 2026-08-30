import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { registrableDomain } from '$lib/utils/domain';
import { computeUptime24h } from '$lib/server/checks';

// The Monitor map (#222, refined in #280): all of the user's monitors, reduced to
// what the graph needs — status (node colour), tags and registrable domain (the two
// grouping modes), and 24h uptime (the secondary metric line under each node).
export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) {
		throw redirect(303, '/signin');
	}

	const rows = await locals.pb!.collection('monitors').getFullList({
		filter: locals.pb!.filter('user = {:user}', { user: locals.user.id }),
		fields: 'id,name,type,status,target,tags,enabled',
		sort: 'name'
	});

	// One uptime query per monitor (an N+1, same pattern as the list). The map loads
	// the whole fleet, so this grows with it — acceptable for typical sizes.
	const monitors = await Promise.all(
		rows.map(async (m: any) => ({
			id: m.id as string,
			name: (m.name as string) ?? '',
			// A disabled monitor isn't scheduled, so its stored status goes stale —
			// surface it as paused, matching the rest of the app.
			status: m.enabled ? (m.status as string) || 'pending' : 'paused',
			tags: Array.isArray(m.tags) ? (m.tags as string[]).filter(Boolean) : [],
			domain: registrableDomain(m.target ?? ''),
			uptime24h: await computeUptime24h(locals.pb!, m.id as string)
		}))
	);

	return { monitors };
};
