// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { POST } from './+server';
import { PATCH } from './[id]/+server';

// Plan limits on alert channel types (#678).
function fake(sub: Record<string, unknown> | null = null, currentType = 'email') {
	const create = vi.fn(async (data: Record<string, unknown>) => ({ id: 'c-new', ...data }));
	const update = vi.fn(async (id: string, data: Record<string, unknown>) => ({ id, ...data }));
	const pb = {
		filter: (expr: string, params: Record<string, unknown>) => `${expr} ${JSON.stringify(params)}`,
		collection(name: string) {
			return {
				create,
				update,
				getOne: async () => ({ id: 'c1', type: currentType }),
				getList: async () =>
					name === 'subscriptions' ? { items: sub ? [sub] : [] } : { items: [], totalItems: 0 }
			};
		}
	};
	const locals = { user: { id: 'u1', created: '2030-01-01 00:00:00.000Z' }, pb };
	return { locals, create, update };
}

const PRO = { plan: 'pro', status: 'active', source: 'admin' };
const SLACK = { type: 'slack', name: 'Team', url: 'https://hooks.slack.com/services/T/B/x' };
const EMAIL = { type: 'email', name: 'Me', email: 'me@example.com' };

function form(fields: Record<string, string>) {
	const fd = new FormData();
	for (const [k, v] of Object.entries({ enabled: 'true', ...fields })) fd.set(k, v);
	return fd;
}
const post = (locals: unknown, f: Record<string, string>) =>
	POST({ locals, request: new Request('http://x', { method: 'POST', body: form(f) }) } as never);
const patch = (locals: unknown, f: Record<string, string>) =>
	PATCH({
		locals,
		params: { id: 'c1' },
		request: new Request('http://x', { method: 'PATCH', body: form(f) })
	} as never);

describe('alert channel types by plan', () => {
	it('Free refuses adding a Slack channel, inline on the type, naming what is included', async () => {
		const { locals, create } = fake();
		const res = await post(locals, SLACK);
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.errors[0].field).toBe('type');
		expect(body.errors[0].message).toContain('email, push and webhook');
		expect(body.errors[0].message).toContain('Slack is not included');
		expect(create).not.toHaveBeenCalled();
	});

	it('Free adds an email channel', async () => {
		const { locals, create } = fake();
		expect((await post(locals, EMAIL)).status).toBe(201);
		expect(create).toHaveBeenCalledTimes(1);
	});

	it('Pro adds a Slack channel', async () => {
		const { locals, create } = fake(PRO);
		expect((await post(locals, SLACK)).status).toBe(201);
		expect(create).toHaveBeenCalledTimes(1);
	});

	it('Free keeps editing a Slack channel it already has', async () => {
		const { locals, update } = fake(null, 'slack');
		expect((await patch(locals, SLACK)).status).toBe(200);
		expect(update).toHaveBeenCalledTimes(1);
	});

	it('Free refuses switching an email channel to Slack', async () => {
		const { locals, update } = fake(null, 'email');
		expect((await patch(locals, SLACK)).status).toBe(400);
		expect(update).not.toHaveBeenCalled();
	});
});
