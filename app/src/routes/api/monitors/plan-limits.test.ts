// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { POST } from './+server';
import { PATCH } from './[id]/+server';
import { PLANS } from '#lib/plans.js';

// Plan limits on monitors (#678). A fake user client: `monitors` is how many the
// account has (before and after the insert), `sub` its subscriptions row.
function fake({
	monitors = 0,
	afterInsert,
	sub = null,
	currentInterval = 300
}: {
	monitors?: number;
	afterInsert?: number;
	sub?: Record<string, unknown> | null;
	currentInterval?: number;
} = {}) {
	let inserted = false;
	const create = vi.fn(async (data: Record<string, unknown>) => {
		inserted = true;
		return { id: 'm-new', ...data };
	});
	const update = vi.fn(async (id: string, data: Record<string, unknown>) => ({ id, ...data }));
	const del = vi.fn(async () => true);
	const pb = {
		filter: (expr: string, params: Record<string, unknown>) => `${expr} ${JSON.stringify(params)}`,
		collection(name: string) {
			return {
				create,
				update,
				delete: del,
				getOne: async () => ({ id: 'm1', interval: currentInterval }),
				getList: async () => {
					if (name === 'subscriptions') return { items: sub ? [sub] : [], totalItems: sub ? 1 : 0 };
					const n = inserted ? (afterInsert ?? monitors + 1) : monitors;
					return { items: [], totalItems: n };
				}
			};
		}
	};
	// Created after the launch cutoff: a Free account unless `sub` says otherwise.
	const locals = { user: { id: 'u1', created: '2030-01-01 00:00:00.000Z' }, pb };
	return { locals, create, update, del };
}

const PRO = { plan: 'pro', status: 'active', source: 'admin' };

function form(fields: Record<string, string>) {
	const fd = new FormData();
	for (const [k, v] of Object.entries({
		name: 'Site',
		type: 'website',
		target: 'https://example.com',
		enabled: 'true',
		...fields
	}))
		fd.set(k, v);
	return fd;
}

const post = (locals: unknown, fields: Record<string, string>) =>
	POST({
		locals,
		request: new Request('http://x', { method: 'POST', body: form(fields) })
	} as never);

const patch = (locals: unknown, fields: Record<string, string>) =>
	PATCH({
		locals,
		params: { id: 'm1' },
		request: new Request('http://x', { method: 'PATCH', body: form(fields) })
	} as never);

describe('POST /api/monitors on Free', () => {
	it('refuses the 11th monitor and says the existing ones keep running', async () => {
		const { locals, create } = fake({ monitors: PLANS.free.monitors });
		const res = await post(locals, { interval: '300' });
		expect(res.status).toBe(402);
		const body = await res.json();
		expect(body.message).toContain(`${PLANS.free.monitors} monitors`);
		expect(body.message).toContain('keep running');
		expect(create).not.toHaveBeenCalled();
	});

	it('refuses a 30 second interval, inline on the interval field', async () => {
		const { locals, create } = fake();
		const res = await post(locals, { interval: '30' });
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.errors).toEqual([
			{ field: 'interval', message: expect.stringContaining('5 minutes') }
		]);
		expect(create).not.toHaveBeenCalled();
	});

	it('adds the 10th monitor at the minimum interval', async () => {
		const { locals, create } = fake({ monitors: PLANS.free.monitors - 1 });
		const res = await post(locals, { interval: '300' });
		expect(res.status).toBe(201);
		expect(create).toHaveBeenCalledTimes(1);
	});

	it('gives the row back when a parallel request filled the last place first', async () => {
		const { locals, del } = fake({
			monitors: PLANS.free.monitors - 1,
			afterInsert: PLANS.free.monitors + 1
		});
		const res = await post(locals, { interval: '300' });
		expect(res.status).toBe(402);
		expect(del).toHaveBeenCalledWith('m-new');
	});
});

describe('POST /api/monitors on Pro', () => {
	it('allows the 11th monitor at 30 seconds', async () => {
		const { locals, create } = fake({ monitors: PLANS.free.monitors, sub: PRO });
		const res = await post(locals, { interval: '30' });
		expect(res.status).toBe(201);
		expect(create).toHaveBeenCalledTimes(1);
	});

	it('a lapsed Pro past its grace period is Free again', async () => {
		const lapsed = { plan: 'pro', status: 'canceled', current_period_end: '2020-01-01 00:00:00Z' };
		const { locals } = fake({ sub: lapsed });
		expect((await post(locals, { interval: '30' })).status).toBe(400);
	});

	it('accounts from before the launch are Pro without a subscription row', async () => {
		const { locals, create } = fake({ monitors: PLANS.free.monitors });
		locals.user.created = '2026-01-01 00:00:00.000Z';
		expect((await post(locals, { interval: '30' })).status).toBe(201);
		expect(create).toHaveBeenCalled();
	});
});

describe('PATCH /api/monitors/[id]', () => {
	it('refuses making a Free monitor faster than 5 minutes', async () => {
		const { locals, update } = fake({ currentInterval: 300 });
		const res = await patch(locals, { interval: '60' });
		expect(res.status).toBe(400);
		expect(update).not.toHaveBeenCalled();
	});

	it('keeps an interval the monitor already had, so an older monitor stays editable', async () => {
		const { locals, update } = fake({ currentInterval: 60 });
		const res = await patch(locals, { interval: '60', name: 'Renamed' });
		expect(res.status).toBe(200);
		expect(update).toHaveBeenCalledTimes(1);
	});

	it('allows 30 seconds on Pro', async () => {
		const { locals, update } = fake({ currentInterval: 300, sub: PRO });
		expect((await patch(locals, { interval: '30' })).status).toBe(200);
		expect(update).toHaveBeenCalledTimes(1);
	});
});
