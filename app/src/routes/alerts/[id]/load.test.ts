import { test, expect } from 'vitest';
import { load } from './+page.server';

function fakeLocals(user: any, opts: { channel?: any; eventList?: any } = {}) {
	const { channel, eventList } = opts;
	return {
		user,
		pb: {
			collection: () => ({
				getOne: async () => channel,
				getList: async () => eventList ?? { items: [], page: 1, perPage: 10, totalItems: 0 }
			})
		}
	};
}

test('returns the channel + paginated delivery log for the owner', async () => {
	const res: any = await load({
		locals: fakeLocals(
			{ id: 'u1' },
			{
				channel: { id: 'ch1', user: 'u1', type: 'email', target: 'a@b', enabled: true },
				eventList: {
					items: [{ id: 'e1', kind: 'test', outcome: 'delivered', detail: '', created: 'c' }],
					page: 1,
					perPage: 10,
					totalItems: 12
				}
			}
		),
		params: { id: 'ch1' },
		url: new URL('http://x/alerts/ch1')
	} as any);
	expect(res.channel.id).toBe('ch1');
	expect(res.events).toHaveLength(1);
	expect(res.pagination.totalItems).toBe(12);
});

test('404s a channel owned by someone else', async () => {
	await expect(
		load({
			locals: fakeLocals(
				{ id: 'u1' },
				{ channel: { id: 'ch1', user: 'someone-else', type: 'email' } }
			),
			params: { id: 'ch1' },
			url: new URL('http://x/alerts/ch1')
		} as any)
	).rejects.toMatchObject({ status: 404 });
});
