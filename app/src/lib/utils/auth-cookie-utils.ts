import * as CipherUtils from '$lib/cipher-utils';

export type AuthProviderCallbackData = {
	name: string;
	state: string;
	codeVerifier: string;
	redirectUrl: string;
};

export function createAuthCookie(provider: AuthProviderCallbackData, key?: string) {
	if (!key) {
		throw new Error('Error logging in with the auth provider.');
	}

	const authData = {
		provider: provider.name,
		state: provider.state,
		codeVerifier: provider.codeVerifier
	};

	const encryptedAuthData = CipherUtils.encrypt(JSON.stringify(authData), key);
	document.cookie = `auth-data=${encryptedAuthData}`;
}
