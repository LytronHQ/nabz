import { describe, expect, it, vi } from 'vitest';

// The uptime math has its own tests (availability.test.ts); here it is a stub.
vi.mock('#lib/server/availability.js', () => ({
	getAvailabilityOverview: vi.fn(async () => [
		{
			key: '30d',
			label: '30d',
			availability: 99.5,
			downtimeMs: 0,
			incidents: 0,
			fromMs: 0,
			toMs: 30,
			dataStartMs: 0,
			down: []
		}
	])
}));

const { loadPublicStatusPage, saveStatusPage, validateStatusPage, readStatusPageForm } =
	await import('./status-pages');

type Row = Record<string, unknown> & { id: string };

// A fake PocketBase that applies the filters these functions build, so a test can
// see what a query would really return. pb.filter keeps the params for that.
function fakePb(db: {
	status_pages?: Row[];
	monitors?: Row[];
	incidents?: Row[];
	users?: Row[];
	subscriptions?: Row[];
}) {
	const calls: { coll: string; opts: Record<string, unknown> }[] = [];
	const created: Row[] = [];
	const deleted: string[] = [];
	const match = (row: Row, f: { expr: string; params: Record<string, unknown> } | undefined) => {
		if (!f) return true;
		const p = f.params;
		// By the expression, not by which params happen to be passed: a query that
		// drops `user = {:u}` must return other accounts' rows here too.
		if (f.expr.includes('slug = {:s}') && row.slug !== p.s) return false;
		if (f.expr.includes('user = {:u}') && row.user !== p.u) return false;
		if (f.expr.includes('id = {:id}') && row.id !== p.id) return false;
		const ids = Object.keys(p)
			.filter((k) => /^m\d+$/.test(k))
			.map((k) => p[k]);
		if (ids.length && f.expr.includes('id = {:m') && !ids.includes(row.id)) return false;
		if (ids.length && f.expr.includes('monitor = {:m') && !ids.includes(row.monitor)) return false;
		return true;
	};
	const pb = {
		filter: (expr: string, params: Record<string, unknown>) => ({ expr, params }),
		collection(name: string) {
			const rows = () => [
				...((db as Record<string, Row[]>)[name] ?? []),
				...(name === 'status_pages' ? created : [])
			];
			return {
				getList: async (_p: number, _n: number, opts: Record<string, unknown> = {}) => {
					calls.push({ coll: name, opts });
					const items = rows().filter((r) => match(r, opts.filter as never));
					return { items, totalItems: items.length };
				},
				getFullList: async (opts: Record<string, unknown> = {}) => {
					calls.push({ coll: name, opts });
					return rows().filter((r) => match(r, opts.filter as never));
				},
				create: async (body: Record<string, unknown>) => {
					const rec = { id: `new${created.length}`, ...body } as Row;
					created.push(rec);
					return rec;
				},
				update: async (id: string, body: Record<string, unknown>) => ({ id, ...body }),
				delete: async (id: string) => {
					deleted.push(id);
					const i = created.findIndex((r) => r.id === id);
					if (i >= 0) created.splice(i, 1);
				}
			};
		}
	};
	return { pb, calls, created, deleted };
}

const OWNER = 'owner0000000001';
const STRANGER = 'stranger0000001';
const DB = () => ({
	status_pages: [
		{
			id: 'sp1',
			user: OWNER,
			slug: 'acme',
			title: 'Acme',
			description: 'Our services',
			monitors: ['mA', 'mB', 'mX']
		}
	],
	monitors: [
		{
			id: 'mA',
			user: OWNER,
			name: 'Website',
			status: 'up',
			enabled: true,
			target: 'https://secret.internal:8443/health'
		},
		{ id: 'mB', user: OWNER, name: 'API', status: 'down', enabled: true, target: '10.0.0.7:5432' },
		{
			id: 'mC',
			user: OWNER,
			name: 'Not on the page',
			status: 'up',
			enabled: true,
			target: 'https://hidden.example'
		},
		// Someone else's monitor, its id slipped into the page's relation.
		{
			id: 'mX',
			user: STRANGER,
			name: 'Stranger DB',
			status: 'up',
			enabled: true,
			target: 'db.stranger'
		}
	],
	incidents: [
		{
			id: 'i1',
			monitor: 'mB',
			started_at: new Date().toISOString().replace('T', ' '),
			resolved_at: '',
			cause: 'dial tcp 10.0.0.7:5432: connection refused'
		}
	],
	users: [{ id: OWNER, created: '2030-01-01 00:00:00.000Z' }]
});

describe('loadPublicStatusPage (#679)', () => {
	it('returns null for an unknown slug, and for one that is not a valid slug', async () => {
		const { pb } = fakePb(DB());
		expect(await loadPublicStatusPage(pb as never, 'nope')).toBeNull();
		expect(await loadPublicStatusPage(pb as never, '../admin')).toBeNull();
	});

	it('shows only the chosen monitors, in order, and never another account’s', async () => {
		const { pb } = fakePb(DB());
		const page = await loadPublicStatusPage(pb as never, 'acme');
		expect(page?.monitors.map((m) => m.name)).toEqual(['Website', 'API']);
	});

	it('leaks no target, cause or account id', async () => {
		const { pb, calls } = fakePb(DB());
		const page = await loadPublicStatusPage(pb as never, 'acme');
		const out = JSON.stringify(page);
		for (const secret of [
			'secret.internal',
			'10.0.0.7',
			'hidden.example',
			'Stranger',
			'connection refused',
			OWNER
		]) {
			expect(out).not.toContain(secret);
		}
		// Not even fetched: the incident query asks for times only.
		const inc = calls.find((c) => c.coll === 'incidents');
		expect(String(inc?.opts.fields)).not.toContain('cause');
		expect(page?.incidents).toEqual([
			expect.objectContaining({ monitor: 'API', resolvedAt: null })
		]);
	});

	it('says some systems are down when one is', async () => {
		const { pb } = fakePb(DB());
		expect((await loadPublicStatusPage(pb as never, 'acme'))?.overall).toBe('down');
	});

	it('carries the "powered by" footer on Free and not on Pro', async () => {
		const free = fakePb(DB());
		expect((await loadPublicStatusPage(free.pb as never, 'acme'))?.poweredBy).toBe(true);
		const pro = fakePb({
			...DB(),
			subscriptions: [{ id: 's', user: OWNER, plan: 'pro', status: 'active' }]
		});
		expect((await loadPublicStatusPage(pro.pb as never, 'acme'))?.poweredBy).toBe(false);
	});
});

describe('saveStatusPage (#679)', () => {
	const user = { id: OWNER, created: '2030-01-01 00:00:00.000Z' };
	const input = { title: 'Status', slug: 'my-status', description: '', monitors: ['mA', 'mX'] };

	it('drops a monitor that is not the owner’s', async () => {
		const { pb, created } = fakePb({ ...DB(), status_pages: [] });
		const res = await saveStatusPage(pb as never, user, input);
		expect(res.ok).toBe(true);
		expect(created[0].monitors).toEqual(['mA']);
	});

	it('refuses a page made only of other accounts’ monitors', async () => {
		const { pb, created } = fakePb({ ...DB(), status_pages: [] });
		const res = await saveStatusPage(pb as never, user, { ...input, monitors: ['mX'] });
		expect(res.ok).toBe(false);
		expect(created).toHaveLength(0);
	});

	it('Free refuses a second page, and says the first stays online', async () => {
		const { pb, created } = fakePb(DB());
		const res = await saveStatusPage(pb as never, user, input);
		expect(res).toMatchObject({ ok: false, status: 402 });
		expect(res.ok === false && res.message).toContain('stay online');
		expect(created).toHaveLength(0);
	});

	it('Pro may add a second page', async () => {
		const { pb } = fakePb({
			...DB(),
			subscriptions: [{ id: 's', user: OWNER, plan: 'pro', status: 'active' }]
		});
		expect((await saveStatusPage(pb as never, user, input)).ok).toBe(true);
	});

	it('turns a taken slug into a field error', async () => {
		const { pb } = fakePb({ ...DB(), status_pages: [] });
		pb.collection = ((orig) => (name: string) => {
			const c = orig(name);
			if (name === 'status_pages')
				c.create = async () => {
					throw { status: 400, data: { data: { slug: { code: 'validation_not_unique' } } } };
				};
			return c;
		})(pb.collection.bind(pb));
		const res = await saveStatusPage(pb as never, user, input);
		expect(res.ok === false && res.errors.slug).toContain('already taken');
	});
});

describe('validation', () => {
	it('checks title, slug and monitors', () => {
		expect(validateStatusPage({ title: '', slug: 'A b', description: '', monitors: [] })).toEqual({
			title: expect.any(String),
			slug: expect.any(String),
			monitors: expect.any(String)
		});
		expect(
			validateStatusPage({ title: 'ok', slug: 'ok-1', description: '', monitors: ['m'] })
		).toEqual({});
	});

	it('reads the form, lowercasing the slug and de-duplicating monitors', () => {
		const fd = new FormData();
		fd.set('title', ' Acme ');
		fd.set('slug', ' Acme-Status ');
		fd.append('monitors', 'm1');
		fd.append('monitors', 'm1');
		expect(readStatusPageForm(fd)).toEqual({
			title: 'Acme',
			slug: 'acme-status',
			description: '',
			monitors: ['m1']
		});
	});
});
