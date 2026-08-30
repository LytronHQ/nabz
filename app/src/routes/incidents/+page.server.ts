import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { DefaultPageSize } from '$lib/constants';

// Open/resolved filter expressed against PocketBase (composes with pagination so a
// filtered list isn't limited to one page). Collection list rules already scope
// incidents to the signed-in user.
const FILTERS = { open: 'resolved_at = ""', resolved: 'resolved_at != ""' } as const;
type Filter = 'all' | keyof typeof FILTERS;

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) {
		throw redirect(303, '/signin');
	}

	const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
	const param = url.searchParams.get('filter');
	const filter: Filter = param === 'open' || param === 'resolved' ? param : 'all';

	const opts: Record<string, unknown> = { sort: '-started_at', expand: 'monitor' };
	if (filter !== 'all') opts.filter = FILTERS[filter];

	const res = await locals.pb!.collection('incidents').getList(page, DefaultPageSize, opts);
	// Header counts are global (independent of the view filter) so the pager alone
	// reflects the filtered view. Reuse res for the total when unfiltered.
	const open = await locals.pb!.collection('incidents').getList(1, 1, { filter: FILTERS.open });
	const totalCount =
		filter === 'all'
			? res.totalItems
			: (await locals.pb!.collection('incidents').getList(1, 1, {})).totalItems;

	const incidents = res.items.map((i) => ({
		id: i.id,
		monitorId: i.monitor,
		monitor: i.expand?.monitor?.name ?? '(deleted monitor)',
		started_at: i.started_at,
		resolved_at: i.resolved_at,
		cause: i.cause
	}));

	return {
		incidents,
		filter,
		openCount: open.totalItems,
		totalCount,
		pagination: { current: res.page, size: res.perPage, totalItems: res.totalItems }
	};
};
