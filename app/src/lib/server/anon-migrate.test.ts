import { test, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/server/service-pb', () => ({ serviceClient: vi.fn() }));
const { serviceClient } = await import('$lib/server/service-pb');
const { migrateAnonMonitors } = await import('./anon-migrate');

type AnonRow = Record<string, unknown> & { id: string };

function fakePb(
	anonRows: AnonRow[],
	created: Record<string, unknown>[],
	deleted: string[],
	failCreateFor?: string
) {
	return {
		filter: (expr: string, params: Record<string, unknown>) => ({ expr, params }),
		collection(name: string) {
			return {
				getFullList: async () => (name === 'anon_monitors' ? anonRows : []),
				create: async (data: Record<string, unknown>) => {
					if (name !== 'monitors') throw new Error('unexpected create on ' + name);
					if (failCreateFor && data.target === failCreateFor) throw new Error('boom');
					created.push(data);
					return { id: 'mon-' + created.length };
				},
				delete: async (id: string) => {
					deleted.push(id);
				}
			};
		}
	};
}

beforeEach(() => vi.mocked(serviceClient).mockReset());

test('migrates each anon monitor into monitors under the user, then deletes the anon copy', async () => {
	const created: Record<string, unknown>[] = [];
	const deleted: string[] = [];
	const rows: AnonRow[] = [
		{
			id: 'a1',
			name: 'one',
			type: 'website',
			target: 'https://one.example',
			interval: 300,
			config: { keyword: 'ok' }
		},
		{
			id: 'a2',
			name: 'two',
			type: 'website',
			target: 'https://two.example',
			interval: 600,
			config: {}
		}
	];
	vi.mocked(serviceClient).mockResolvedValue(fakePb(rows, created, deleted) as never);

	const n = await migrateAnonMonitors('sess-token', 'user-123');

	expect(n).toBe(2);
	expect(created).toHaveLength(2);
	// The new rows are owned by the user, land in the real zones, and are enabled.
	expect(created[0]).toMatchObject({
		user: 'user-123',
		target: 'https://one.example',
		type: 'website',
		enabled: true,
		zones: [],
		status: 'pending'
	});
	expect(created[0].config).toEqual({ keyword: 'ok' });
	expect(deleted).toEqual(['a1', 'a2']); // anon copies removed
});

test('is best-effort: one failing row does not block the others', async () => {
	const created: Record<string, unknown>[] = [];
	const deleted: string[] = [];
	const rows: AnonRow[] = [
		{ id: 'a1', name: 'bad', type: 'website', target: 'https://bad.example', interval: 300 },
		{ id: 'a2', name: 'good', type: 'website', target: 'https://good.example', interval: 300 }
	];
	vi.mocked(serviceClient).mockResolvedValue(
		fakePb(rows, created, deleted, 'https://bad.example') as never
	);
	vi.spyOn(console, 'error').mockImplementation(() => {});

	const n = await migrateAnonMonitors('sess-token', 'user-123');

	expect(n).toBe(1);
	expect(created).toHaveLength(1);
	expect(created[0].target).toBe('https://good.example');
	expect(deleted).toEqual(['a2']); // the failed row's anon copy is left for the TTL to clean
});

test('no-ops (no service client call) without a token or user id', async () => {
	expect(await migrateAnonMonitors('', 'user-123')).toBe(0);
	expect(await migrateAnonMonitors('sess', '')).toBe(0);
	expect(serviceClient).not.toHaveBeenCalled();
});

test('returns 0 (never throws into signup) when the backend read fails', async () => {
	vi.spyOn(console, 'error').mockImplementation(() => {});
	const pb = {
		filter: () => ({}),
		collection: () => ({
			getFullList: async () => {
				throw new Error('list failed');
			},
			create: async () => ({ id: 'x' }),
			delete: async () => {}
		})
	};
	vi.mocked(serviceClient).mockResolvedValue(pb as never);
	expect(await migrateAnonMonitors('sess', 'user-123')).toBe(0);
});
