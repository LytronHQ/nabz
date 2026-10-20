import { defineEnvVars } from '@sveltejs/kit/env';

// Every variable is optional and an unset one reads as ''. That matches how the
// code already treated `$env/dynamic/private` values: each consumer tests for a
// falsy value or falls back with `||` (never `??`, which '' would bypass), so an
// unset PB_URL, token or allowlist still means "not configured".
export const variables = defineEnvVars({
	COOKIE_SECURE: { schema: (input) => input ?? '' },
	ADMIN_EMAILS: { schema: (input) => input ?? '' },
	PB_URL: { schema: (input) => input ?? '' },
	WEB_PB_USERNAME: { schema: (input) => input ?? '' },
	WEB_PB_PASSWORD: { schema: (input) => input ?? '' },
	WEB_PB_COLLECTION: { schema: (input) => input ?? '' },
	HEALTH_DEBUG_TOKEN: { schema: (input) => input ?? '' },
	PKCE_FLOW_ENCRYPTION_KEY: { schema: (input) => input ?? '' },
	HEALTH_STALE_SECONDS: { schema: (input) => input ?? '' },
	WEB_BEAT_STALE_SECONDS: { schema: (input) => input ?? '' },
	CF_ACCESS_CLIENT_ID: { schema: (input) => input ?? '' },
	CF_ACCESS_CLIENT_SECRET: { schema: (input) => input ?? '' },
	// The public half of the Web Push key pair (#602). Public by nature: browsers
	// need it to subscribe. The private half lives only with the evaluator.
	VAPID_PUBLIC_KEY: { schema: (input) => input ?? '' }
});
