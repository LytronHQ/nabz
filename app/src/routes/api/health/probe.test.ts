import { test, expect, vi, beforeEach } from 'vitest';

const mockEnv: Record<string, string> = {};
// Getters, not values: the module reads these per call, and each test sets its
// own mockEnv before importing (unset reads as '', like the real module).
vi.mock('$app/env/private', () => ({
	get PB_URL() {
		return mockEnv.PB_URL ?? '';
	},
	get CF_ACCESS_CLIENT_ID() {
		return mockEnv.CF_ACCESS_CLIENT_ID ?? '';
	},
	get CF_ACCESS_CLIENT_SECRET() {
		return mockEnv.CF_ACCESS_CLIENT_SECRET ?? '';
	},
	get HEALTH_STALE_SECONDS() {
		return mockEnv.HEALTH_STALE_SECONDS ?? '';
	},
	get WEB_BEAT_STALE_SECONDS() {
		return mockEnv.WEB_BEAT_STALE_SECONDS ?? '';
	},
	get HEALTH_DEBUG_TOKEN() {
		return mockEnv.HEALTH_DEBUG_TOKEN ?? '';
	}
}));

beforeEach(() => {
	for (const k of Object.keys(mockEnv)) delete mockEnv[k];
	vi.restoreAllMocks();
});

/** The probe is a raw fetch, not an SDK call, so it has to carry the Access
 *  service token itself. Without it Cloudflare Access answers 403 and the
 *  endpoint reports a perfectly healthy PocketBase as unreachable — and never
 *  recovers, because the condition is configuration, not a transient fault. */
test('the PocketBase probe signs its request to Cloudflare Access', async () => {
	mockEnv.PB_URL = 'https://pb-staging.example';
	mockEnv.CF_ACCESS_CLIENT_ID = 'id-123';
	mockEnv.CF_ACCESS_CLIENT_SECRET = 'secret-456';

	const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(
		async () => new Response('{}', { status: 200 })
	);
	vi.stubGlobal('fetch', fetchMock);

	const { GET } = await import('./+server');
	await GET({ request: new Request('https://web.example/api/health') } as never);

	const [url, init] = fetchMock.mock.calls[0];
	expect(url).toBe('https://pb-staging.example/api/health');
	expect(init.headers).toMatchObject({
		'CF-Access-Client-Id': 'id-123',
		'CF-Access-Client-Secret': 'secret-456'
	});
});

test('with no service token configured it sends none — dev has no Access in the path', async () => {
	mockEnv.PB_URL = 'http://127.0.0.1:8090';

	const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(
		async () => new Response('{}', { status: 200 })
	);
	vi.stubGlobal('fetch', fetchMock);

	const { GET } = await import('./+server');
	await GET({ request: new Request('https://web.example/api/health') } as never);

	const [, init] = fetchMock.mock.calls[0];
	expect(init.headers).toEqual({});
});

// /api/health is what external monitoring polls, so it is where "which web build
// is live" has to be answerable (#489).
test('the public body carries the web version and commit', async () => {
	mockEnv.PB_URL = 'http://127.0.0.1:8090';
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => new Response('{}', { status: 200 }))
	);
	const { GET } = await import('./+server');
	const { APP_VERSION, APP_COMMIT } = await import('#lib/version.js');
	const res = await GET({ request: new Request('https://web.example/api/health') } as never);
	const body = await res.json();
	expect(body.version).toBe(APP_VERSION);
	expect(body.version).toMatch(/^\d+\.\d+\.\d+$/);
	expect(body.commit).toBe(APP_COMMIT);
});
