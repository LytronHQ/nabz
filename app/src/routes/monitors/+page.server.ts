import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { DefaultPageSize } from '$lib/constants';

// Server-render the first page of the user's monitors so the list is present on
// navigation instead of flashing the empty/placeholder state while a client-side
// fetch resolves (#118). Uptime-24h is intentionally NOT computed here — it's a
// slow per-monitor query (N+1); the client fills it in after hydration and takes
// over polling / search / filter / pagination from there.
export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) {
		throw redirect(303, '/signin');
	}

	const monitors = await locals.pb!.collection('monitors').getList(1, DefaultPageSize, {
		filter: locals.pb!.filter('user = {:user}', { user: locals.user.id }),
		sort: '-created'
	});

	return { monitors };
};
