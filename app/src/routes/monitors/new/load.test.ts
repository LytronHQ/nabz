import { test, expect } from 'vitest';
import { load } from './+page.server';

function fakeLocals(user: any) {
	return {
		user,
		pb: {
			filter: (expr: string) => expr, // binding exercised in the app; passthrough here
			collection: () => ({
				// zone_stats.getList — duplicate + empty zones exercise the de-dupe
				getList: async () => ({
					items: [{ zone: 'eu' }, { zone: 'us' }, { zone: 'eu' }, { zone: '' }]
				}),
				// escalation_policies.getFullList
				getFullList: async () => [{ id: 'p1', name: 'Oncall' }]
			})
		}
	};
}

test('new-monitor load returns deduped zones and policies for an authed user', async () => {
	const res: any = await load({ locals: fakeLocals({ id: 'u1' }) } as any);
	// The codes and their liveness are what this load test is about; labelling is
	// covered in monitor-form.test.ts.
	expect(res.availableZones.map((z: { zone: string; stale: boolean }) => ({ zone: z.zone, stale: z.stale }))).toEqual([
		{ zone: 'eu', stale: true },
		{ zone: 'us', stale: true }
	]);
	expect(res.availablePolicies).toEqual([{ id: 'p1', name: 'Oncall' }]);
});

test('new-monitor load redirects to /signin when unauthenticated', async () => {
	await expect(load({ locals: fakeLocals(null) } as any)).rejects.toMatchObject({
		status: 303,
		location: '/signin'
	});
});
