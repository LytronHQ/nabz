import { describe, expect, it, vi } from 'vitest';
import { setPlanByEmail } from './admin-plans';

function fakePb(opts: {
	user?: { id: string; email: string } | null;
	row?: Record<string, unknown> | null;
}) {
	const create = vi.fn(async (b: object) => ({ id: 's1', ...b }));
	const update = vi.fn(async (id: string, b: object) => ({ id, ...b }));
	const pb = {
		filter: (expr: string, params: Record<string, unknown>) => `${expr} ${JSON.stringify(params)}`,
		collection(name: string) {
			return {
				create,
				update,
				getList: async () => {
					if (name === 'users') return { items: opts.user ? [opts.user] : [] };
					return { items: opts.row ? [opts.row] : [] };
				}
			};
		}
	};
	return { pb, create, update };
}

describe('setPlanByEmail (#678)', () => {
	it('creates an admin Pro row for an account that has none', async () => {
		const { pb, create } = fakePb({ user: { id: 'u1', email: 'a@b.c' } });
		const res = await setPlanByEmail(pb as never, ' A@B.C ', 'pro', 'friend');
		expect(res).toEqual({ ok: true, message: 'a@b.c is now on Pro.' });
		expect(create).toHaveBeenCalledWith({
			user: 'u1',
			plan: 'pro',
			status: 'active',
			source: 'admin',
			note: 'friend'
		});
	});

	it('updates the row an admin set before', async () => {
		const { pb, update } = fakePb({
			user: { id: 'u1', email: 'a@b.c' },
			row: { id: 's9', source: 'admin', plan: 'pro' }
		});
		await setPlanByEmail(pb as never, 'a@b.c', 'free', '');
		expect(update).toHaveBeenCalledWith('s9', expect.objectContaining({ plan: 'free' }));
	});

	it('leaves a Stripe-managed row alone', async () => {
		const { pb, create, update } = fakePb({
			user: { id: 'u1', email: 'a@b.c' },
			row: { id: 's9', source: 'stripe', plan: 'pro' }
		});
		const res = await setPlanByEmail(pb as never, 'a@b.c', 'free', '');
		expect(res.ok).toBe(false);
		expect(create).not.toHaveBeenCalled();
		expect(update).not.toHaveBeenCalled();
	});

	it('says when no account has that address, and that GitHub/Google accounts need the id', async () => {
		const { pb } = fakePb({ user: null });
		const res = await setPlanByEmail(pb as never, 'x@y.z', 'pro', '');
		expect(res.ok).toBe(false);
		expect(res.message).toContain('use the account id instead');
	});

	it('finds an account by its id, for one whose email PocketBase hides', async () => {
		const { pb, create } = fakePb({ user: { id: 'abcdefghij12345', email: '' } });
		const spy = vi.spyOn(pb, 'filter');
		const res = await setPlanByEmail(pb as never, 'abcdefghij12345', 'pro', '');
		expect(res.ok).toBe(true);
		expect(spy).toHaveBeenCalledWith('id = {:id}', { id: 'abcdefghij12345' });
		expect(create).toHaveBeenCalledWith(expect.objectContaining({ user: 'abcdefghij12345' }));
	});

	it('refuses an unknown plan', async () => {
		const { pb, create } = fakePb({ user: { id: 'u1', email: 'a@b.c' } });
		expect((await setPlanByEmail(pb as never, 'a@b.c', 'gold' as never, '')).ok).toBe(false);
		expect(create).not.toHaveBeenCalled();
	});
});

describe('listPlanRows', () => {
	it('names each account by email, read through a users list', async () => {
		const { listPlanRows } = await import('./admin-plans');
		const pb = {
			filter: (expr: string, params: Record<string, unknown>) =>
				`${expr} ${JSON.stringify(params)}`,
			collection(name: string) {
				return {
					getFullList: async () =>
						name === 'subscriptions'
							? [
									{
										id: 's1',
										user: 'u1',
										plan: 'pro',
										status: 'active',
										source: 'admin',
										note: '',
										updated: '2026-11-03 08:00:00Z'
									}
								]
							: [{ id: 'u1', email: 'a@b.c' }]
				};
			}
		};
		const rows = await listPlanRows(pb as never);
		expect(rows).toEqual([
			expect.objectContaining({ userId: 'u1', email: 'a@b.c', plan: 'pro', source: 'admin' })
		]);
	});
});
