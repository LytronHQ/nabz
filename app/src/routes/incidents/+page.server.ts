import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { DefaultPageSize } from '#lib/constants.js';
import { getZoneLabels } from '#lib/server/zones.js';
import { nameZonesInText } from '#lib/utils/zone-order.js';
import { getAccountPlan } from '#lib/server/plan.js';
import { historyMessage, historyStart } from '#lib/plans.js';

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

	// The plan's history window (#703): incidents that started inside it, plus any
	// still open however old, because an open one is current, not history.
	const { plan } = await getAccountPlan(locals.pb!, locals.user);
	const earliest = historyStart(plan);
	const inWindow = earliest
		? locals.pb!.filter('(started_at >= {:since} || resolved_at = "")', {
				since: earliest.toISOString().replace('T', ' ')
			})
		: '';
	const both = (a: string, b: string) => [a, b].filter(Boolean).join(' && ');

	const opts: Record<string, unknown> = { sort: '-started_at', expand: 'monitor' };
	const viewFilter = both(inWindow, filter !== 'all' ? FILTERS[filter] : '');
	if (viewFilter) opts.filter = viewFilter;

	const res = await locals.pb!.collection('incidents').getList(page, DefaultPageSize, opts);
	// Header counts are global (independent of the view filter) so the pager alone
	// reflects the filtered view. Reuse res for the total when unfiltered.
	const open = await locals.pb!.collection('incidents').getList(1, 1, { filter: FILTERS.open });
	const totalCount =
		filter === 'all'
			? res.totalItems
			: (
					await locals
						.pb!.collection('incidents')
						.getList(1, 1, inWindow ? { filter: inWindow } : {})
				).totalItems;

	const labels = await getZoneLabels(locals.pb!);
	const incidents = res.items.map((i) => ({
		id: i.id,
		monitorId: i.monitor,
		monitor: i.expand?.monitor?.name ?? '(deleted monitor)',
		started_at: i.started_at,
		resolved_at: i.resolved_at,
		cause: nameZonesInText(i.cause ?? '', labels)
	}));

	return {
		incidents,
		filter,
		openCount: open.totalItems,
		totalCount,
		historyMessage: earliest ? historyMessage(plan) : '',
		pagination: { current: res.page, size: res.perPage, totalItems: res.totalItems }
	};
};
