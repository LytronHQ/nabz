import { test, expect } from 'vitest';
import { load } from './+page.server';

// The fakes stub only what load touches, so the event is a deliberate partial.
type LoadEvent = Parameters<typeof load>[0];
type LoadData = Exclude<Awaited<ReturnType<typeof load>>, void>;
const run = async (event: object) => (await load(event as LoadEvent)) as LoadData;

type FakeList = { items: object[]; page: number; perPage: number; totalItems: number };

function fakeLocals(
	user: { id: string } | null,
	opts: { policyList?: FakeList; channels?: object[] } = {}
) {
	const { policyList, channels = [] } = opts;
	return {
		user,
		pb: {
			collection: () => ({
				getList: async () => policyList ?? { items: [], page: 1, perPage: 10, totalItems: 0 },
				getFullList: async () => channels
			})
		}
	};
}

test('policies paginate; channels load in full for the editor', async () => {
	const policyList = {
		items: [{ id: 'p1', name: 'Crit', steps: [] }],
		page: 2,
		perPage: 10,
		totalItems: 15
	};
	const res = await run({
		locals: fakeLocals(
			{ id: 'u1' },
			{
				policyList,
				channels: [
					{
						id: 'c1',
						type: 'email',
						name: 'Ops inbox',
						config: { email: 'a@b.com' },
						enabled: true
					},
					{
						id: 'c2',
						type: 'webhook',
						config: { url: 'https://hooks.example.com/x/abcdef' },
						enabled: true
					}
				]
			}
		),
		url: new URL('http://x/escalations?page=2')
	});
	expect(res.policies).toHaveLength(1);
	expect(res.pagination).toEqual({ current: 2, size: 10, totalItems: 15 });
	expect(res.channels).toHaveLength(2); // not paginated
	// named channel shows its name; unnamed falls back to "provider · target" (#144)
	expect(res.channels[0].label).toBe('Ops inbox');
	expect(res.channels[1].label).toBe('webhook · hooks.example.com · …abcdef');
});

test('redirects to /signin when not authenticated', async () => {
	await expect(
		run({ locals: fakeLocals(null), url: new URL('http://x/escalations') })
	).rejects.toMatchObject({
		status: 303,
		location: '/signin'
	});
});
