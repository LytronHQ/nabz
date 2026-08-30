import { redirect } from '@sveltejs/kit';
import type { RequestEvent, RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import * as CipherUtils from '$lib/cipher-utils';
import { migrateAnonMonitors } from '$lib/server/anon-migrate';
import { clearAnonCookie } from '$lib/server/anon';

export const GET: RequestHandler = async ({ locals, url, cookies }: RequestEvent) => {
	const redirectURL = `${url.origin}/auth/callback`;

	const authMethods = await locals.pb?.collection('users').listAuthMethods();
	if (!authMethods?.oauth2?.providers) {
		throw redirect(303, '/signin');
	}

	const encryptedAuthData = cookies.get('auth-data');
	if (!encryptedAuthData) {
		throw redirect(303, '/signin');
	}
	const encryptionKey = env.PKCE_FLOW_ENCRYPTION_KEY;
	if (!encryptionKey) {
		console.error('PKCE_FLOW_ENCRYPTION_KEY is not set — cannot complete OAuth callback');
		throw redirect(303, '/signin');
	}
	const authDataDecryptedString = CipherUtils.decrypt(encryptedAuthData, encryptionKey);
	const autData = JSON.parse(authDataDecryptedString);

	const provider = authMethods.oauth2.providers.find((p) => p.name === autData.provider);
	if (!provider) {
		throw redirect(303, '/signin');
	}

	const query = new URLSearchParams(url.search);
	const state = query.get('state');
	if (autData.state !== state) {
		throw redirect(303, `/signin`);
	}

	const code = query.get('code');
	await locals.pb
		?.collection('users')
		.authWithOAuth2Code(provider.name, code || '', autData.codeVerifier, redirectURL)
		.then(async (authData) => {
			// user logged in

			const meta = authData.meta;
			if (meta) {
				const formData = new FormData();
				const response = await fetch(meta.avatarUrl);
				if (response.ok) {
					const file = await response.blob();
					formData.append('avatar', file);
				}

				formData.append('name', meta.name);
				await locals.pb?.collection('users').update(authData.record.id, formData);
			}

			// Keep an anonymously-tried monitor on OAuth signup/login too (#272).
			if (locals.anonSession && authData.record?.id) {
				await migrateAnonMonitors(locals.anonSession, authData.record.id);
				clearAnonCookie(cookies);
			}
		})
		.catch((err) => {
			console.log('Error logging in with 0Auth user', err);
		});

	throw redirect(303, '/dashboard');
};
