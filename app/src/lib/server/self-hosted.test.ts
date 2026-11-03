// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

// #694: on a self-hosted install (no HOSTED_PLANS) nothing is limited. v0.13.0
// shipped without this, and a self-hoster's new accounts got the Free limits.
vi.mock('$app/env/private', async (importOriginal) => ({
	...((await importOriginal()) as object),
	HOSTED_PLANS: ''
}));

const { getAccountPlan, getPlanUsage } = await import('./plan');
const { POST } = await import('../../routes/api/monitors/+server');
const { POST: POST_CHANNEL } = await import('../../routes/api/alert-channels/+server');

// A brand-new account with plenty of monitors already, and no subscription row.
function fakePb(monitors = 50) {
	const create = vi.fn(async (d: Record<string, unknown>) => ({ id: 'new', ...d }));
	return {
		create,
		pb: {
			filter: (e: string, p: object) => `${e} ${JSON.stringify(p)}`,
			collection: () => ({
				create,
				getList: async () => ({ items: [], totalItems: monitors })
			})
		}
	};
}
const user = { id: 'u1', created: '2030-01-01 00:00:00.000Z' };

function form(fields: Record<string, string>) {
	const fd = new FormData();
	for (const [k, v] of Object.entries(fields)) fd.set(k, v);
	return new Request('http://x', { method: 'POST', body: fd });
}

describe('self-hosted (#694)', () => {
	it('every account is on the unlimited self-hosted plan', async () => {
		const { pb } = fakePb();
		const { plan, reason } = await getAccountPlan(pb as never, user);
		expect(reason).toBe('self-hosted');
		expect(plan.monitors).toBe(Infinity);
		expect(plan.statusPageFooter).toBe(false);
		expect((await getPlanUsage(pb as never, user)).limited).toBe(false);
	});

	it('adds a 51st monitor at 30 seconds', async () => {
		const { pb, create } = fakePb(50);
		const res = await POST({
			locals: { user, pb },
			request: form({
				name: 'Site',
				type: 'website',
				target: 'https://example.com',
				interval: '30',
				enabled: 'true'
			})
		} as never);
		expect(res.status).toBe(201);
		expect(create).toHaveBeenCalledTimes(1);
	});

	it('adds a Slack channel', async () => {
		const { pb, create } = fakePb();
		const res = await POST_CHANNEL({
			locals: { user, pb },
			request: form({
				type: 'slack',
				name: 'Team',
				url: 'https://hooks.slack.com/services/T/B/x',
				enabled: 'true'
			})
		} as never);
		expect(res.status).toBe(201);
		expect(create).toHaveBeenCalledTimes(1);
	});
});
