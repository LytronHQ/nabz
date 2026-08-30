import { test, expect } from 'vitest';
import { load } from './+page.server';

function fakeLocals(user: any, opts: { policyList?: any; channels?: any[] } = {}) {
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
	const res: any = await load({
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
	} as any);
	expect(res.policies).toHaveLength(1);
	expect(res.pagination).toEqual({ current: 2, size: 10, totalItems: 15 });
	expect(res.channels).toHaveLength(2); // not paginated
	// named channel shows its name; unnamed falls back to "provider · target" (#144)
	expect(res.channels[0].label).toBe('Ops inbox');
	expect(res.channels[1].label).toBe('webhook · hooks.example.com · …abcdef');
});

test('redirects to /signin when not authenticated', async () => {
	await expect(
		load({ locals: fakeLocals(null), url: new URL('http://x/escalations') } as any)
	).rejects.toMatchObject({
		status: 303,
		location: '/signin'
	});
});
