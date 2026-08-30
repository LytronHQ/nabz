import { test, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/server/service-pb', () => ({ serviceClient: vi.fn() }));
const { serviceClient } = await import('$lib/server/service-pb');
const { load } = await import('./+page.server');

function fakePb(row: unknown, notFound = false) {
	return {
		collection: () => ({
			getOne: async () => {
				if (notFound) throw new Error('404');
				return row;
			}
		})
	};
}

const run = (locals: Record<string, unknown>) =>
	(load as unknown as (e: unknown) => Promise<unknown>)({ params: { id: 'm1' }, locals });

beforeEach(() => vi.mocked(serviceClient).mockReset());

test('no anon session → 404 (never reaches PB)', async () => {
	await expect(run({})).rejects.toMatchObject({ status: 404 });
	expect(serviceClient).not.toHaveBeenCalled();
});

test('a row owned by a DIFFERENT session → 404 (no leaking other trials)', async () => {
	vi.mocked(serviceClient).mockResolvedValue(
		fakePb({ id: 'm1', session: 'someone-else' }) as never
	);
	await expect(run({ anonSession: 'mine' })).rejects.toMatchObject({ status: 404 });
});

test('a missing row (expired/migrated) → friendly expired state, not an error', async () => {
	vi.mocked(serviceClient).mockResolvedValue(fakePb(null, true) as never);
	await expect(run({ anonSession: 'mine' })).resolves.toMatchObject({
		expired: true,
		monitor: null
	});
});

test('own row → returns the monitor', async () => {
	vi.mocked(serviceClient).mockResolvedValue(
		fakePb({
			id: 'm1',
			session: 'mine',
			name: 'demo',
			target: 'https://x',
			type: 'website',
			status: 'up',
			interval: 300
		}) as never
	);
	const res = (await run({ anonSession: 'mine' })) as {
		expired: boolean;
		monitor: { id: string; target: string };
	};
	expect(res.expired).toBe(false);
	expect(res.monitor).toMatchObject({ id: 'm1', target: 'https://x' });
});
