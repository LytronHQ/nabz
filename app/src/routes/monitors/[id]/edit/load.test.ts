import { test, expect } from 'vitest';
import { load } from './+page.server';

// The fakes stub only what load touches, so the event is a deliberate partial.
type LoadEvent = Parameters<typeof load>[0];
type LoadData = Exclude<Awaited<ReturnType<typeof load>>, void>;
const run = async (event: object) => (await load(event as LoadEvent)) as LoadData;

function fakeLocals(user: { id: string } | null, monitorExists = true) {
	return {
		user,
		pb: {
			filter: (expr: string) => expr,
			collection: () => ({
				getOne: async () => {
					if (!monitorExists) throw new Error('not found');
					return { id: 'm1', name: 'Alpha', type: 'website', target: 'https://a.com' };
				},
				getList: async () => ({ items: [{ zone: 'eu' }] }),
				getFullList: async () => [{ id: 'p1', name: 'Oncall' }]
			})
		}
	};
}

test('edit load returns the monitor plus form options', async () => {
	const res = await run({
		locals: fakeLocals({ id: 'u1' }),
		params: { id: 'm1' }
	});
	expect(res.monitor.id).toBe('m1');
	expect(res.monitor.name).toBe('Alpha');
	expect(
		res.availableZones.map((z: { zone: string; stale: boolean }) => ({
			zone: z.zone,
			stale: z.stale
		}))
	).toEqual([{ zone: 'eu', stale: true }]);
	expect(res.availablePolicies).toEqual([{ id: 'p1', name: 'Oncall' }]);
});

test('edit load 404s when the monitor is missing', async () => {
	await expect(
		run({ locals: fakeLocals({ id: 'u1' }, false), params: { id: 'x' } })
	).rejects.toMatchObject({ status: 404 });
});

test('edit load redirects to /signin when unauthenticated', async () => {
	await expect(run({ locals: fakeLocals(null), params: { id: 'm1' } })).rejects.toMatchObject({
		status: 303,
		location: '/signin'
	});
});
