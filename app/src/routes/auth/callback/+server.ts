import { redirect } from '@sveltejs/kit';
import type { RequestEvent, RequestHandler } from './$types';
import { PKCE_FLOW_ENCRYPTION_KEY } from '$app/env/private';
import * as CipherUtils from '#lib/cipher-utils.js';
import { migrateAnonMonitors } from '#lib/server/anon-migrate.js';
import { clearAnonCookie } from '#lib/server/anon.js';

type Sealed = { provider?: string; state?: string; codeVerifier?: string; linkTo?: string };

// Where a sign-in that did not complete goes, with the reason /signin explains.
// Every failure used to redirect to /dashboard, which bounced a signed-out user
// to /signin with no word on what happened (#609).
const back = (reason: 'cancelled' | 'failed') => redirect(303, `/signin?oauth=${reason}`);
// Connecting from /account (#622) reports back there instead.
const backToAccount = (outcome: 'connected' | 'cancelled' | 'failed' | 'taken', provider = '') =>
	redirect(303, `/account?connect=${outcome}${provider ? `&provider=${provider}` : ''}`);

function unseal(encrypted: string | undefined): Sealed | null {
	if (!encrypted || !PKCE_FLOW_ENCRYPTION_KEY) return null;
	try {
		return JSON.parse(CipherUtils.decrypt(encrypted, PKCE_FLOW_ENCRYPTION_KEY));
	} catch {
		// A cookie sealed with an earlier key (it was rotated after #580) or tampered with.
		return null;
	}
}

export const GET: RequestHandler = async ({ locals, url, cookies }: RequestEvent) => {
	const redirectURL = `${url.origin}/auth/callback`;

	const encryptedAuthData = cookies.get('auth-data');
	// Single use: a callback replayed later must not find the sealed state again.
	cookies.delete('auth-data', { path: '/auth/callback' });
	if (!PKCE_FLOW_ENCRYPTION_KEY) {
		console.error('PKCE_FLOW_ENCRYPTION_KEY is not set — cannot complete OAuth callback');
	}
	const sealed = unseal(encryptedAuthData);
	const linking = !!sealed?.linkTo;
	const fail = linking ? () => backToAccount('failed') : () => back('failed');

	// The provider's consent page was declined (GitHub and Google both send
	// error=access_denied). Not a failure; nothing to log.
	if (url.searchParams.get('error') === 'access_denied') {
		throw linking ? backToAccount('cancelled') : back('cancelled');
	}

	const authMethods = await locals.pb?.collection('users').listAuthMethods();
	if (!authMethods?.oauth2?.providers || !sealed) throw fail();
	const provider = authMethods.oauth2.providers.find((p) => p.name === sealed.provider);
	const code = url.searchParams.get('code');
	if (!provider || !code || sealed.state !== url.searchParams.get('state')) throw fail();

	// Linking needs the same signed-in user that started it: PocketBase links the
	// identity to whoever the request is authenticated as.
	if (linking && locals.user?.id !== sealed.linkTo) throw fail();
	const before = linking
		? { token: locals.pb!.authStore.token, record: locals.pb!.authStore.record }
		: null;

	let userId: string;
	try {
		// Signed out: PocketBase links this to an existing user with the same email,
		// or creates one with name and avatar filled from the provider
		// (users.oauth2.mappedFields, set by deploy/pb-oauth.sh). Signed in (link
		// mode): it links the identity to the signed-in user, whatever its email.
		const authData = await locals
			.pb!.collection('users')
			.authWithOAuth2Code(provider.name, code, sealed.codeVerifier ?? '', redirectURL);
		userId = authData.record.id;
	} catch (err) {
		console.error('OAuth sign-in failed', provider.name, (err as Error)?.message);
		if (before) locals.pb!.authStore.save(before.token, before.record);
		throw fail();
	}

	if (before) {
		// An identity already linked to ANOTHER nabz account signs in as that
		// account, even when the request is authenticated. Connecting must never
		// switch accounts: put the original session back and say why.
		if (userId !== sealed.linkTo) {
			locals.pb!.authStore.save(before.token, before.record);
			throw backToAccount('taken', provider.name);
		}
		throw backToAccount('connected', provider.name);
	}

	// Keep an anonymously-tried monitor on OAuth signup/login too (#272).
	if (locals.anonSession) {
		try {
			await migrateAnonMonitors(locals.anonSession, userId);
			clearAnonCookie(cookies);
		} catch (err) {
			// Signed in either way; losing the trial monitor is not worth failing that.
			console.error(
				'keeping the trial monitor after OAuth sign-in failed',
				(err as Error)?.message
			);
		}
	}

	throw redirect(303, '/dashboard');
};
