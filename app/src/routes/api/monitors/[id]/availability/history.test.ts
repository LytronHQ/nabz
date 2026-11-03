// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { GET } from './+server';
import { historyStart, PLANS } from '#lib/plans.js';

// #703: the custom From/To range cannot reach further back than the plan shows.
// Refused, not clipped: a quietly clipped range would report the wrong dates.
function fakeLocals(subscription?: object) {
	return {
		user: { id: 'u1', created: '2030-01-01 00:00:00.000Z' },
		pb: {
			filter: (e: string) => e,
			collection: (name: string) => ({
				getList: async () => ({ items: subscription ? [subscription] : [], totalItems: 0 }),
				getOne: async () => ({ id: 'm1', user: 'u1' }),
				getFullList: async () => (name === 'incidents' ? [] : [])
			})
		}
	};
}
const day = (d: Date) => d.toISOString().slice(0, 10);
const call = (locals: object, from: string) =>
	GET({
		locals,
		params: { id: 'm1' },
		url: new URL(`http://x/api/monitors/m1/availability?from=${from}&to=${day(new Date())}`)
	} as never);

describe('custom range and the history window', () => {
	const earliest = historyStart(PLANS.free)!;

	it('Free: a From date before the last 30 days is refused, with the date to use', async () => {
		const res = await call(fakeLocals(), day(new Date(earliest.getTime() - 86_400_000)));
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toContain('last 30 days');
		expect(body.error).toContain(day(earliest));
	});

	it('Free: the first day of the window is allowed', async () => {
		const res = await call(fakeLocals(), day(earliest));
		expect(res.status).toBe(200);
	});

	it('Pro: 100 days back is allowed', async () => {
		const res = await call(
			fakeLocals({ plan: 'pro', status: 'active' }),
			day(new Date(Date.now() - 100 * 86_400_000))
		);
		expect(res.status).toBe(200);
	});
});
