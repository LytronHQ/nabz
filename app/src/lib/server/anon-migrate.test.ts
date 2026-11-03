import { test, expect, vi, beforeEach } from 'vitest';

vi.mock('#lib/server/service-pb.js', () => ({ serviceClient: vi.fn() }));
const { serviceClient } = await import('#lib/server/service-pb.js');
const { migrateAnonMonitors } = await import('./anon-migrate');

type AnonRow = Record<string, unknown> & { id: string };

// The account the trial moves into (#678): how many monitors it already has, its
// subscription row, and when it was created. The default is a new Free account.
type Account = { monitors?: number; sub?: Record<string, unknown> | null; created?: string };

function fakePb(
	anonRows: AnonRow[],
	created: Record<string, unknown>[],
	deleted: string[],
	failCreateFor?: string,
	account: Account = {}
) {
	return {
		filter: (expr: string, params: Record<string, unknown>) => ({ expr, params }),
		collection(name: string) {
			return {
				getList: async () => {
					if (name === 'users')
						return {
							items: [{ id: 'user-123', created: account.created ?? '2030-01-01 00:00:00Z' }]
						};
					if (name === 'subscriptions') return { items: account.sub ? [account.sub] : [] };
					if (name === 'monitors') return { items: [], totalItems: account.monitors ?? 0 };
					throw new Error('unexpected getList on ' + name);
				},
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

// Plan limits (#678).

test('leaves the trial behind when the account is already at its Free monitor limit', async () => {
	const created: Record<string, unknown>[] = [];
	const deleted: string[] = [];
	const rows: AnonRow[] = [
		{ id: 'a1', name: 'one', type: 'website', target: 'https://one.example', interval: 300 }
	];
	vi.mocked(serviceClient).mockResolvedValue(
		fakePb(rows, created, deleted, undefined, { monitors: 10 }) as never
	);
	vi.spyOn(console, 'warn').mockImplementation(() => {});

	expect(await migrateAnonMonitors('sess', 'user-123')).toBe(0);
	expect(created).toHaveLength(0);
	expect(deleted).toEqual([]); // still in anon_monitors, to expire with the session
});

test('moves only as many trials as the plan has room for', async () => {
	const created: Record<string, unknown>[] = [];
	const deleted: string[] = [];
	const rows: AnonRow[] = [
		{ id: 'a1', name: 'one', type: 'website', target: 'https://one.example', interval: 300 },
		{ id: 'a2', name: 'two', type: 'website', target: 'https://two.example', interval: 300 }
	];
	vi.mocked(serviceClient).mockResolvedValue(
		fakePb(rows, created, deleted, undefined, { monitors: 9 }) as never
	);
	vi.spyOn(console, 'warn').mockImplementation(() => {});

	expect(await migrateAnonMonitors('sess', 'user-123')).toBe(1);
	expect(deleted).toEqual(['a1']);
});

test('a Pro account takes the trial even past the Free monitor limit', async () => {
	const created: Record<string, unknown>[] = [];
	const deleted: string[] = [];
	const rows: AnonRow[] = [
		{ id: 'a1', name: 'one', type: 'website', target: 'https://one.example', interval: 300 }
	];
	vi.mocked(serviceClient).mockResolvedValue(
		fakePb(rows, created, deleted, undefined, {
			monitors: 10,
			sub: { plan: 'pro', status: 'active' }
		}) as never
	);

	expect(await migrateAnonMonitors('sess', 'user-123')).toBe(1);
	expect(created[0]).toMatchObject({ user: 'user-123', interval: 300 });
});

test('a trial interval below the plan minimum is raised to it', async () => {
	const created: Record<string, unknown>[] = [];
	const rows: AnonRow[] = [
		{ id: 'a1', name: 'one', type: 'website', target: 'https://one.example', interval: 60 }
	];
	vi.mocked(serviceClient).mockResolvedValue(fakePb(rows, created, []) as never);

	await migrateAnonMonitors('sess', 'user-123');
	expect(created[0].interval).toBe(300);
});
