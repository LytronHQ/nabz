import { redirect } from '@sveltejs/kit';
import { dev } from '$app/env';
import { PKCE_FLOW_ENCRYPTION_KEY } from '$app/env/private';
import type { RequestEvent } from '@sveltejs/kit';
import * as CipherUtils from '#lib/cipher-utils.js';

// Starts an OAuth sign-in (/auth/start) or connect (/auth/connect). The provider's
// state and PKCE verifier are sealed into an httpOnly cookie here, on the server,
// so the key never leaves it: the pages used to do this in the browser and so had
// to be sent the key (#580).
export async function startOAuth(
	{
		locals,
		url,
		params,
		cookies
	}: Pick<RequestEvent, 'locals' | 'url' | 'cookies'> & {
		params: { provider: string };
	},
	link: boolean
): Promise<never> {
	// www.nabz.sh serves the app too, but an OAuth app is registered with ONE
	// callback, https://nabz.sh/auth/callback. Started here, the provider would
	// refuse www's callback, and the state cookie would be on the wrong host for
	// the apex's. So begin again on the apex (#609).
	if (url.hostname.startsWith('www.')) {
		const apex = new URL(url);
		apex.hostname = url.hostname.slice('www.'.length);
		throw redirect(303, apex.toString(), { external: [apex.origin] });
	}

	// link: /auth/connect connects the provider to the signed-in account from
	// /account (#622) instead of signing in. Only for a signed-in user, and the
	// user id is sealed with the state so the callback can refuse to come back as
	// anyone else.
	if (link && !locals.user) throw redirect(303, '/signin');
	const giveUp = link ? '/account?connect=failed' : '/signin';

	const key = PKCE_FLOW_ENCRYPTION_KEY;
	const authMethods = await locals.pb?.collection('users').listAuthMethods();
	const provider = authMethods?.oauth2?.providers?.find((p) => p.name === params.provider);
	if (!key || !provider) throw redirect(303, giveUp);

	const sealed = CipherUtils.encrypt(
		JSON.stringify({
			provider: provider.name,
			state: provider.state,
			codeVerifier: provider.codeVerifier,
			...(link ? { linkTo: locals.user!.id } : {})
		}),
		key
	);
	cookies.set('auth-data', sealed, {
		path: '/auth/callback',
		httpOnly: true,
		sameSite: 'lax',
		secure: !dev,
		maxAge: 600
	});
	const target = `${provider.authURL}${url.origin}/auth/callback`;
	// SvelteKit 3 refuses external redirects unless allowed; allow exactly the
	// provider's own origin, which comes from PocketBase's auth methods.
	throw redirect(303, target, { external: [new URL(target).origin] });
}
