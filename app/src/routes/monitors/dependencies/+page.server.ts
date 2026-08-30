import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// Dependencies (#223): the user's monitors back the edge picker and (next
// increment) the directional graph nodes. Edges themselves are loaded on the
// client via the store, mirroring the other management pages.
export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) {
		throw redirect(303, '/signin');
	}

	const rows = await locals.pb!.collection('monitors').getFullList({
		filter: locals.pb!.filter('user = {:user}', { user: locals.user.id }),
		fields: 'id,name,status,enabled',
		sort: 'name'
	});

	const monitors = rows.map((m: any) => ({
		id: m.id as string,
		name: (m.name as string) ?? '',
		// A disabled monitor isn't scheduled, so surface it as paused (matches the map).
		status: m.enabled ? (m.status as string) || 'pending' : 'paused'
	}));

	return { monitors };
};
