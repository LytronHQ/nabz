import { test, expect } from 'vitest';
import { load } from './+page.server';

// The fakes stub only what load touches, so the event is a deliberate partial.
type LoadEvent = Parameters<typeof load>[0];
type LoadData = Exclude<Awaited<ReturnType<typeof load>>, void>;
const run = async (event: object) => (await load(event as LoadEvent)) as LoadData;

function fakeLocals(user: { id: string } | null) {
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
	const res = await run({ locals: fakeLocals({ id: 'u1' }) });
	// The codes and their liveness are what this load test is about; labelling is
	// covered in monitor-form.test.ts.
	expect(
		res.availableZones.map((z: { zone: string; stale: boolean }) => ({
			zone: z.zone,
			stale: z.stale
		}))
	).toEqual([
		{ zone: 'eu', stale: true },
		{ zone: 'us', stale: true }
	]);
	expect(res.availablePolicies).toEqual([{ id: 'p1', name: 'Oncall' }]);
});

test('new-monitor load redirects to /signin when unauthenticated', async () => {
	await expect(run({ locals: fakeLocals(null) })).rejects.toMatchObject({
		status: 303,
		location: '/signin'
	});
});
