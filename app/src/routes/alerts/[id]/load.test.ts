import { test, expect } from 'vitest';
import { load } from './+page.server';

// The fakes stub only what load touches, so the event is a deliberate partial.
type LoadEvent = Parameters<typeof load>[0];
type LoadData = Exclude<Awaited<ReturnType<typeof load>>, void>;
const run = async (event: object) => (await load(event as LoadEvent)) as LoadData;

type FakeList = { items: object[]; page: number; perPage: number; totalItems: number };

function fakeLocals(
	user: { id: string } | null,
	opts: { channel?: object; eventList?: FakeList } = {}
) {
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
	const res = await run({
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
	});
	expect(res.channel.id).toBe('ch1');
	expect(res.events).toHaveLength(1);
	expect(res.pagination.totalItems).toBe(12);
});

test('404s a channel owned by someone else', async () => {
	await expect(
		run({
			locals: fakeLocals(
				{ id: 'u1' },
				{ channel: { id: 'ch1', user: 'someone-else', type: 'email' } }
			),
			params: { id: 'ch1' },
			url: new URL('http://x/alerts/ch1')
		})
	).rejects.toMatchObject({ status: 404 });
});
