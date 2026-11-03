import { test, expect, vi, beforeEach } from 'vitest';

vi.mock('#lib/server/service-pb.js', () => ({ serviceClient: vi.fn() }));
const { serviceClient } = await import('#lib/server/service-pb.js');
const { POST } = await import('./+server');

// An in-memory anon_monitors collection whose calls each take a round trip, so
// parallel requests interleave the way they do against a real PocketBase.
function fakePb() {
	const rows: { id: string; ip_hash: string; session: string }[] = [];
	let n = 0;
	const tick = () => new Promise((r) => setTimeout(r, 5));
	const parse = (f: string) => /ip_hash = '([^']+)'/.exec(f)?.[1];
	return {
		rows,
		filter: (expr: string, p: Record<string, string>) =>
			expr.replace(/\{:(\w+)\}/g, (_, k) => `'${p[k]}'`),
		collection: () => ({
			getList: async (_p: number, _pp: number, o: { filter?: string } = {}) => {
				await tick();
				const h = o.filter ? parse(o.filter) : undefined;
				const s = o.filter && /session = '([^']+)'/.exec(o.filter)?.[1];
				const items = rows.filter((r) => (h ? r.ip_hash === h : s ? r.session === s : true));
				return { totalItems: items.length, items: [] };
			},
			create: async (data: { ip_hash: string; session: string }) => {
				await tick();
				const row = { id: `r${++n}`, ...data };
				rows.push(row);
				return row;
			},
			delete: async (id: string) => {
				await tick();
				const i = rows.findIndex((r) => r.id === id);
				if (i >= 0) rows.splice(i, 1);
			}
		})
	};
}

const post = (ip: string) =>
	POST({
		request: new Request('http://x/api/anon/monitors', {
			method: 'POST',
			body: JSON.stringify({ target: 'https://example.com/' })
		}),
		locals: {},
		cookies: { set: () => {} },
		getClientAddress: () => ip
	} as never);

let pb: ReturnType<typeof fakePb>;
beforeEach(() => {
	pb = fakePb();
	vi.mocked(serviceClient).mockResolvedValue(pb as never);
});

test('one at a time, a network gets 5 trials and then a refusal', async () => {
	const codes = [];
	for (let i = 0; i < 6; i++) codes.push((await post('203.0.113.9')).status);
	expect(codes).toEqual([201, 201, 201, 201, 201, 429]);
	expect(pb.rows).toHaveLength(5);
});

// Parallel cookieless requests all passed the count taken before the insert (#671).
test('20 parallel requests from one address leave at most 5 trials', async () => {
	await Promise.all(Array.from({ length: 20 }, () => post('203.0.113.9')));
	expect(pb.rows.length).toBeLessThanOrEqual(5);
});

// Each address in a /64 used to have its own budget.
test('addresses in one IPv6 /64 share one limit', async () => {
	const codes = [];
	for (let i = 1; i <= 7; i++) codes.push((await post(`2001:db8:9:9::${i.toString(16)}`)).status);
	expect(codes.filter((c) => c === 201)).toHaveLength(5);
	expect(pb.rows).toHaveLength(5);
});

test('different IPv4 clients are not merged', async () => {
	for (let i = 1; i <= 6; i++) expect((await post(`198.51.100.${i}`)).status).toBe(201);
});
