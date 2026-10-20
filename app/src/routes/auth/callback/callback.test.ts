import { test, expect, vi, beforeEach } from 'vitest';
import * as CipherUtils from '#lib/cipher-utils.js';

const KEY = 'k'.repeat(40);
vi.mock('$app/env/private', () => ({ PKCE_FLOW_ENCRYPTION_KEY: 'k'.repeat(40) }));
const migrate = vi.fn();
vi.mock('#lib/server/anon-migrate.js', () => ({
	migrateAnonMonitors: (...a: unknown[]) => migrate(...a)
}));
vi.mock('#lib/server/anon.js', () => ({ clearAnonCookie: vi.fn() }));

beforeEach(() => migrate.mockReset());

const sealed = (state = 'st-1') =>
	CipherUtils.encrypt(JSON.stringify({ provider: 'github', state, codeVerifier: 'cv-1' }), KEY);

function event(
	query: string,
	opts: { cookie?: string; auth?: () => Promise<unknown>; anon?: string } = {}
) {
	const update = vi.fn();
	const authWithOAuth2Code = vi.fn(
		opts.auth ??
			(async () => ({ record: { id: 'u1' }, meta: { name: 'From GitHub', avatarUrl: '' } }))
	);
	const ev = {
		url: new URL('https://nabz.example/auth/callback' + query),
		cookies: { get: () => opts.cookie ?? sealed(), delete: vi.fn() },
		locals: {
			anonSession: opts.anon,
			pb: {
				collection: () => ({
					listAuthMethods: async () => ({ oauth2: { providers: [{ name: 'github' }] } }),
					authWithOAuth2Code,
					update
				})
			}
		}
	} as never;
	return { ev, update, authWithOAuth2Code };
}

async function run(ev: never) {
	const { GET } = await import('./+server');
	try {
		await GET(ev);
	} catch (r) {
		return (r as { location: string }).location;
	}
	throw new Error('expected a redirect');
}

test('a completed sign-in lands on the dashboard without rewriting the profile', async () => {
	const { ev, update, authWithOAuth2Code } = event('?state=st-1&code=c1', { anon: 'anon-1' });
	expect(await run(ev)).toBe('/dashboard');
	expect(authWithOAuth2Code).toHaveBeenCalledWith(
		'github',
		'c1',
		'cv-1',
		'https://nabz.example/auth/callback'
	);
	// Name and avatar come from PocketBase's mappedFields on creation only. The
	// callback used to overwrite them on every sign-in.
	expect(update).not.toHaveBeenCalled();
	expect(migrate).toHaveBeenCalledWith('anon-1', 'u1');
});

test('Cancel on the consent page says so on /signin', async () => {
	const { ev, authWithOAuth2Code } = event('?state=st-1&error=access_denied');
	expect(await run(ev)).toBe('/signin?oauth=cancelled');
	expect(authWithOAuth2Code).not.toHaveBeenCalled();
});

test('a wrong state, a missing code or a provider error is a failed sign-in, not the dashboard', async () => {
	expect(await run(event('?state=other&code=c1').ev)).toBe('/signin?oauth=failed');
	expect(await run(event('?state=st-1').ev)).toBe('/signin?oauth=failed');
	const rejected = event('?state=st-1&code=c1', {
		auth: async () => {
			throw new Error('invalid code');
		}
	});
	expect(await run(rejected.ev)).toBe('/signin?oauth=failed');
	// A cookie sealed with another key (the key was rotated after #580).
	const stale = event('?state=st-1&code=c1', { cookie: CipherUtils.encrypt('{}', 'x'.repeat(40)) });
	expect(await run(stale.ev)).toBe('/signin?oauth=failed');
});

// Link mode (#622): connecting a provider from /account while signed in.
function linkEvent(opts: { signedInAs?: string; returns?: string; query?: string }) {
	const save = vi.fn();
	const authStore = { token: 'tok-u1', record: { id: 'u1' }, save };
	const authWithOAuth2Code = vi.fn(async () => ({ record: { id: opts.returns ?? 'u1' } }));
	const cookie = CipherUtils.encrypt(
		JSON.stringify({ provider: 'github', state: 'st-1', codeVerifier: 'cv-1', linkTo: 'u1' }),
		KEY
	);
	const ev = {
		url: new URL('https://nabz.example/auth/callback' + (opts.query ?? '?state=st-1&code=c1')),
		cookies: { get: () => cookie, delete: vi.fn() },
		locals: {
			user: opts.signedInAs ? { id: opts.signedInAs } : null,
			pb: {
				authStore,
				collection: () => ({
					listAuthMethods: async () => ({ oauth2: { providers: [{ name: 'github' }] } }),
					authWithOAuth2Code
				})
			}
		}
	} as never;
	return { ev, save, authWithOAuth2Code };
}

test('connecting from /account links the provider and returns there', async () => {
	const { ev, save } = linkEvent({ signedInAs: 'u1' });
	expect(await run(ev)).toBe('/account?connect=connected&provider=github');
	expect(save).not.toHaveBeenCalled();
});

test('an identity already linked to another account never switches the session', async () => {
	// PocketBase signs in as the account that already owns the identity.
	const { ev, save } = linkEvent({ signedInAs: 'u1', returns: 'someone-else' });
	expect(await run(ev)).toBe('/account?connect=taken&provider=github');
	expect(save).toHaveBeenCalledWith('tok-u1', { id: 'u1' });
});

test('link mode reports cancel and a changed user back to /account', async () => {
	expect(
		await run(linkEvent({ signedInAs: 'u1', query: '?state=st-1&error=access_denied' }).ev)
	).toBe('/account?connect=cancelled');
	// Started by u1, finished by a different session: refuse rather than link to it.
	const other = linkEvent({ signedInAs: 'u2' });
	expect(await run(other.ev)).toBe('/account?connect=failed');
	expect(other.authWithOAuth2Code).not.toHaveBeenCalled();
});
