import { test, expect, vi, beforeEach } from 'vitest';
import * as CipherUtils from '#lib/cipher-utils.js';

const mockEnv: Record<string, string> = {};
// A getter: the route reads the key per request, and each test sets its own.
vi.mock('$app/env/private', () => ({
	get PKCE_FLOW_ENCRYPTION_KEY() {
		return mockEnv.PKCE_FLOW_ENCRYPTION_KEY ?? '';
	}
}));

beforeEach(() => {
	for (const k of Object.keys(mockEnv)) delete mockEnv[k];
});

const provider = {
	name: 'github',
	state: 'st-1',
	codeVerifier: 'cv-1',
	authURL: 'https://github.example/authorize?redirect_uri='
};

function event(name: string) {
	const set = vi.fn();
	return {
		set,
		ev: {
			params: { provider: name },
			url: new URL('https://nabz.example/auth/start/' + name),
			cookies: { set },
			locals: {
				pb: {
					collection: () => ({
						listAuthMethods: async () => ({ oauth2: { providers: [provider] } })
					})
				}
			}
		} as never
	};
}

async function run(ev: never) {
	const { GET } = await import('./+server');
	try {
		await GET(ev);
	} catch (r) {
		return r as { status: number; location: string };
	}
	throw new Error('expected a redirect');
}

// The browser used to seal this cookie and so had to be sent the key (#580). Now
// the server seals it, httpOnly, and the key stays where it is.
test('seals the OAuth state server-side in an httpOnly cookie and redirects to the provider', async () => {
	mockEnv.PKCE_FLOW_ENCRYPTION_KEY = 'k'.repeat(40);
	const { set, ev } = event('github');
	const r = await run(ev);
	expect(r.status).toBe(303);
	expect(r.location).toBe(provider.authURL + 'https://nabz.example/auth/callback');
	expect(set).toHaveBeenCalledTimes(1);
	const [name, value, opts] = set.mock.calls[0];
	expect(name).toBe('auth-data');
	expect(opts).toMatchObject({ httpOnly: true, path: '/auth/callback', sameSite: 'lax' });
	expect(JSON.parse(CipherUtils.decrypt(value, mockEnv.PKCE_FLOW_ENCRYPTION_KEY))).toEqual({
		provider: 'github',
		state: 'st-1',
		codeVerifier: 'cv-1'
	});
});

test('an unknown provider or a missing key goes back to /signin without a cookie', async () => {
	mockEnv.PKCE_FLOW_ENCRYPTION_KEY = 'k'.repeat(40);
	const a = event('nope');
	expect((await run(a.ev)).location).toBe('/signin');
	expect(a.set).not.toHaveBeenCalled();
	delete mockEnv.PKCE_FLOW_ENCRYPTION_KEY;
	const b = event('github');
	expect((await run(b.ev)).location).toBe('/signin');
	expect(b.set).not.toHaveBeenCalled();
});

// An OAuth app has one callback, on the apex. Started on www, the provider would
// refuse www's callback and the cookie would sit on the wrong host (#609).
test('a sign-in started on www begins again on the apex, without a cookie', async () => {
	mockEnv.PKCE_FLOW_ENCRYPTION_KEY = 'k'.repeat(40);
	const { set, ev } = event('github');
	(ev as unknown as { url: URL }).url = new URL('https://www.nabz.example/auth/start/github');
	const r = await run(ev);
	expect(r.status).toBe(303);
	expect(r.location).toBe('https://nabz.example/auth/start/github');
	expect(set).not.toHaveBeenCalled();
});

// /auth/connect (#622): only for a signed-in user, whose id is sealed with the state.
async function runConnect(ev: never) {
	const { GET } = await import('../../connect/[provider]/+server');
	try {
		await GET(ev);
	} catch (r) {
		return r as { status: number; location: string };
	}
	throw new Error('expected a redirect');
}

test('/auth/connect seals the signed-in user id; signed out it goes to /signin', async () => {
	mockEnv.PKCE_FLOW_ENCRYPTION_KEY = 'k'.repeat(40);
	const signedOut = event('github');
	expect((await runConnect(signedOut.ev)).location).toBe('/signin');
	expect(signedOut.set).not.toHaveBeenCalled();

	const signedIn = event('github');
	(signedIn.ev as unknown as { locals: { user?: { id: string } } }).locals.user = { id: 'u1' };
	const r = await runConnect(signedIn.ev);
	expect(r.status).toBe(303);
	const [, value] = signedIn.set.mock.calls[0];
	const sealed = JSON.parse(CipherUtils.decrypt(value, mockEnv.PKCE_FLOW_ENCRYPTION_KEY));
	expect(sealed.linkTo).toBe('u1');

	// A plain sign-in never carries a link target, even for a signed-in user.
	const plain = event('github');
	(plain.ev as unknown as { locals: { user?: { id: string } } }).locals.user = { id: 'u1' };
	await run(plain.ev);
	const [, plainValue] = plain.set.mock.calls[0];
	expect(
		JSON.parse(CipherUtils.decrypt(plainValue, mockEnv.PKCE_FLOW_ENCRYPTION_KEY)).linkTo
	).toBeUndefined();
});
