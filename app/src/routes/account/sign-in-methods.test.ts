import { test, expect, vi } from 'vitest';
import { load, actions } from './+page.server';

// Sign-in methods on /account (#622): which providers are on, which this user has
// linked (PocketBase's _externalAuths, read with the user's own token), and
// disconnecting one.
type LoadEvent = Parameters<typeof load>[0];
type ActionEvent = Parameters<(typeof actions)['disconnect']>[0];

function setup(opts: { links?: unknown[] | Error; providers?: string[] } = {}) {
	const del = vi.fn(async () => true);
	const getFullList = vi.fn(async () => {
		if (opts.links instanceof Error) throw opts.links;
		return opts.links ?? [];
	});
	const collection = vi.fn((name: string) =>
		name === '_externalAuths'
			? { getFullList, delete: del }
			: {
					listAuthMethods: async () => ({
						oauth2: {
							enabled: true,
							providers: (opts.providers ?? ['github', 'google']).map((n) => ({ name: n }))
						}
					})
				}
	);
	const locals = {
		user: { id: 'u1', email: 'a@b.com' },
		pb: {
			collection,
			filter: (s: string, p: Record<string, string>) => s.replace('{:id}', `"${p.id}"`)
		}
	};
	return { locals, del, getFullList };
}

const run = (locals: object, query = '') =>
	load({ locals, url: new URL('https://nabz.example/account' + query) } as object as LoadEvent);

test('lists every provider that is on, marking the ones this user has linked', async () => {
	const { locals, getFullList } = setup({
		links: [{ id: 'ea1', provider: 'google', created: '2026-10-19 11:40:00.000Z' }]
	});
	const data = (await run(locals)) as { signInMethods: unknown[]; signInMethodsError: boolean };
	expect(getFullList).toHaveBeenCalledWith({ filter: 'recordRef = "u1"' });
	expect(data.signInMethods).toEqual([
		{ provider: 'github', linkId: null, since: null },
		{ provider: 'google', linkId: 'ea1', since: '2026-10-19 11:40:00.000Z' }
	]);
	expect(data.signInMethodsError).toBe(false);
});

test('a failed read says so instead of showing everything as not connected', async () => {
	const { locals } = setup({ links: new Error('403') });
	const data = (await run(locals)) as { signInMethodsError: boolean };
	expect(data.signInMethodsError).toBe(true);
});

test('passes on the outcome /auth/callback reported, and nothing else', async () => {
	const { locals } = setup();
	expect(
		((await run(locals, '?connect=taken&provider=github')) as { connect: unknown }).connect
	).toEqual({
		outcome: 'taken',
		provider: 'github'
	});
	expect(((await run(locals, '?connect=<script>')) as { connect: unknown }).connect).toBeNull();
});

test("disconnect deletes that link with the user's own token", async () => {
	const { locals, del } = setup();
	const fd = new FormData();
	fd.append('linkId', 'ea1');
	const res = (await actions.disconnect({
		locals,
		request: { formData: async () => fd }
	} as unknown as ActionEvent)) as { success?: boolean };
	expect(del).toHaveBeenCalledWith('ea1');
	expect(res.success).toBe(true);
});
