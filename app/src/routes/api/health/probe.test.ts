import { test, expect, vi, beforeEach } from 'vitest';

const mockEnv: Record<string, string> = {};
vi.mock('$env/dynamic/private', () => ({ env: mockEnv }));

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

	const [url, init] = fetchMock.mock.calls[0] ;
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

	const [, init] = fetchMock.mock.calls[0] ;
	expect(init.headers).toEqual({});
});
