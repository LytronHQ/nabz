import { test, expect } from 'vitest';
import { load } from './+page.server';

// The fakes stub only what load touches, so the event is a deliberate partial.
type LoadEvent = Parameters<typeof load>[0];
type LoadData = Exclude<Awaited<ReturnType<typeof load>>, void>;
const run = async (event: object) => (await load(event as LoadEvent)) as LoadData;

type FakeList = {
	items: object[];
	page: number;
	perPage: number;
	totalItems: number;
	totalPages?: number;
};

// The load makes up to three getList calls: the paged list (perPage = DefaultPageSize),
// a perPage:1 open-count (filter resolved_at=""), and — only when a filter is active —
// a perPage:1 global-total (no filter). Distinguish them by perPage + filter.
function fakeLocals(
	user: { id: string } | null,
	opts: { mainList?: FakeList; openTotal?: number; grandTotal?: number } = {}
) {
	const { mainList, openTotal = 0, grandTotal = 0 } = opts;
	return {
		user,
		pb: {
			collection: () => ({
				getList: async (_page: number, perPage: number, o?: { filter?: string }) => {
					if (perPage === 1 && o?.filter === 'resolved_at = ""')
						return { items: [], page: 1, perPage: 1, totalItems: openTotal, totalPages: 1 };
					if (perPage === 1)
						return { items: [], page: 1, perPage: 1, totalItems: grandTotal, totalPages: 1 };
					return mainList ?? { items: [], page: 1, perPage: 10, totalItems: 0, totalPages: 0 };
				}
			})
		}
	};
}

test('load returns the requested page, pagination metadata, and global counts', async () => {
	const mainList = {
		items: [
			{
				id: 'i1',
				monitor: 'm1',
				started_at: 's',
				resolved_at: '',
				cause: 'down',
				expand: { monitor: { name: 'Alpha' } }
			}
		],
		page: 2,
		perPage: 10,
		totalItems: 25
	};
	const res = await run({
		locals: fakeLocals({ id: 'u1' }, { mainList, openTotal: 4 }),
		url: new URL('http://x/incidents?page=2')
	});

	expect(res.incidents).toHaveLength(1);
	expect(res.incidents[0].monitor).toBe('Alpha');
	expect(res.pagination).toEqual({ current: 2, size: 10, totalItems: 25 });
	expect(res.openCount).toBe(4);
	// filter=all -> total reuses the paged list's total (no extra query)
	expect(res.totalCount).toBe(25);
	expect(res.filter).toBe('all');
});

test('a filtered view reports the global total (not the filtered count)', async () => {
	const mainList = { items: [], page: 1, perPage: 10, totalItems: 3, totalPages: 1 }; // 3 resolved
	const res = await run({
		locals: fakeLocals({ id: 'u1' }, { mainList, openTotal: 12, grandTotal: 15 }),
		url: new URL('http://x/incidents?filter=resolved')
	});
	expect(res.filter).toBe('resolved');
	expect(res.pagination.totalItems).toBe(3); // filtered (drives the pager)
	expect(res.openCount).toBe(12);
	expect(res.totalCount).toBe(15); // global (drives the header)
});

test('an unknown filter falls back to all', async () => {
	const res = await run({
		locals: fakeLocals({ id: 'u1' }),
		url: new URL('http://x/incidents?filter=nope')
	});
	expect(res.filter).toBe('all');
});

test('load redirects to /signin when not authenticated', async () => {
	await expect(
		run({ locals: fakeLocals(null), url: new URL('http://x/incidents') })
	).rejects.toMatchObject({ status: 303, location: '/signin' });
});
