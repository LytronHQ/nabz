import { test, expect, vi } from 'vitest';

vi.mock('$app/env/private', () => ({ PKCE_FLOW_ENCRYPTION_KEY: 'secret-key-value' }));

// /signin and /signup returned this function's result as page data, and it
// carried PKCE_FLOW_ENCRYPTION_KEY: the key was in every visitor's HTML (#580).
test('the sign-in page data carries provider names only, never a key or PKCE state', async () => {
	const { getAuthCallbackData } = await import('./action-utils');
	const locals = {
		pb: {
			collection: () => ({
				listAuthMethods: async () => ({
					oauth2: {
						providers: [{ name: 'github', state: 's', codeVerifier: 'v', authURL: 'https://x/' }]
					}
				})
			})
		}
	} as never;
	const data = await getAuthCallbackData(locals);
	expect(data).toEqual({ providers: [{ name: 'github' }] });
	expect(JSON.stringify(data)).not.toContain('secret-key-value');
});

// An unreachable PocketBase made listAuthMethods throw out of the /signin and
// /signup loads, a 500 page instead of the form (#582). Providers are optional.
test('a PocketBase failure gives the page no providers instead of an error', async () => {
	const { getAuthCallbackData } = await import('./action-utils.js');
	const locals = {
		pb: {
			collection: () => ({
				listAuthMethods: async () => {
					throw new Error('fetch failed');
				}
			})
		}
	} as never;
	await expect(getAuthCallbackData(locals)).resolves.toEqual({});
});
