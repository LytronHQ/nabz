import { describe, it, expect } from 'vitest';
import { changePassword } from './password';

type Update = { id: string; body: Record<string, unknown> };

function fakePb(opts: { updateThrows?: boolean; reauthThrows?: boolean } = {}) {
	const updates: Update[] = [];
	const pb = {
		collection: () => ({
			update: async (id: string, body: Record<string, unknown>) => {
				updates.push({ id, body });
				if (opts.updateThrows) throw new Error('wrong current password');
				return {};
			},
			authWithPassword: async () => {
				if (opts.reauthThrows) throw new Error('no');
				return {};
			}
		})
	};
	return { pb: pb as unknown as Parameters<typeof changePassword>[0], updates };
}

const input = { oldPassword: 'demo1234', password: 'new-one-99', passwordConfirm: 'new-one-99' };

describe('changePassword (#392)', () => {
	it('clears must_change_password in the SAME update as the password', async () => {
		// Not two calls: changing a password invalidates the current token, so a
		// follow-up write to clear the flag would fail and leave the user stuck
		// behind the gate having done exactly what was asked.
		const { pb, updates } = fakePb();
		const res = await changePassword(pb, 'u1', 'a@b.c', input);
		expect(res).toEqual({ ok: true, reauthenticated: true });
		expect(updates).toHaveLength(1);
		expect(updates[0].body).toMatchObject({
			oldPassword: 'demo1234',
			password: 'new-one-99',
			must_change_password: false
		});
	});

	it('reports failure without clearing anything when the change is rejected', async () => {
		const { pb } = fakePb({ updateThrows: true });
		const res = await changePassword(pb, 'u1', 'a@b.c', input);
		expect(res.ok).toBe(false);
	});

	it('still succeeds when re-auth fails, but says the session was not renewed', async () => {
		// The password DID change; the caller sends them to sign in again rather
		// than reporting an error for something that worked.
		const { pb } = fakePb({ reauthThrows: true });
		const res = await changePassword(pb, 'u1', 'a@b.c', input);
		expect(res).toEqual({ ok: true, reauthenticated: false });
	});
});
