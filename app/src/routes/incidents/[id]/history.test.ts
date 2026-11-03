import { describe, expect, it } from 'vitest';
import { load } from './+page.server';

// #703: a resolved incident older than the plan's history is not shown; an open
// one is, however old, because it is current.
const daysAgo = (n: number) =>
	new Date(Date.now() - n * 86_400_000).toISOString().replace('T', ' ');

function event(incident: Record<string, unknown>, subscription?: object) {
	return {
		params: { id: 'i1' },
		locals: {
			user: { id: 'u1', created: '2030-01-01 00:00:00.000Z' },
			pb: {
				filter: (e: string) => e,
				collection: (name: string) => ({
					getList: async () => ({ items: subscription ? [subscription] : [], totalItems: 0 }),
					getFullList: async () => [],
					getOne: async () => ({
						id: 'i1',
						cause: '',
						expand: { monitor: { id: 'm1', user: 'u1', name: 'Site' } },
						...incident,
						name
					})
				})
			}
		}
	};
}
const run = (e: object) => load(e as never);

describe('incident page and the history window', () => {
	it('Free: a resolved incident from 40 days ago is outside the history', async () => {
		await expect(
			run(event({ started_at: daysAgo(40), resolved_at: daysAgo(40) }))
		).rejects.toMatchObject({
			status: 403,
			body: { message: expect.stringContaining('last 30 days') }
		});
	});

	it('Free: an incident still open after 40 days is shown', async () => {
		const res = (await run(event({ started_at: daysAgo(40), resolved_at: '' }))) as {
			incident: { id: string };
		};
		expect(res.incident.id).toBe('i1');
	});

	it('Pro: the same 40-day-old incident is shown', async () => {
		const res = (await run(
			event(
				{ started_at: daysAgo(40), resolved_at: daysAgo(40) },
				{ plan: 'pro', status: 'active' }
			)
		)) as { incident: { id: string } };
		expect(res.incident.id).toBe('i1');
	});
});
