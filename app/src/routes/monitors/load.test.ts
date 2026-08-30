import { test, expect } from 'vitest';
import { load } from './+page.server';

const fakeList = {
	items: [
		{ id: 'm1', name: 'Alpha' },
		{ id: 'm2', name: 'Beta' }
	],
	page: 1,
	perPage: 10,
	totalItems: 2,
	totalPages: 1
};

function fakeLocals(user: any) {
	return {
		user,
		pb: {
			filter: (expr: string) => expr, // binding is exercised in the app; passthrough here
			collection: () => ({ getList: async () => fakeList })
		}
	};
}

test('load server-renders the first page of monitors for an authed user', async () => {
	const res: any = await load({ locals: fakeLocals({ id: 'u1' }) } as any);
	expect(res.monitors.items).toHaveLength(2);
	expect(res.monitors.items[0].name).toBe('Alpha');
	// Uptime is intentionally not computed server-side (the N+1) — raw records only.
	expect(res.monitors.items[0].uptime24h).toBeUndefined();
});

test('load redirects to /signin when not authenticated', async () => {
	await expect(load({ locals: fakeLocals(null) } as any)).rejects.toMatchObject({
		status: 303,
		location: '/signin'
	});
});
