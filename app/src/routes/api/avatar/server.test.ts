import { describe, test, expect, vi, beforeEach } from 'vitest';

const mockEnv: Record<string, string | undefined> = {};
vi.mock('$env/dynamic/private', () => ({ env: mockEnv }));

const { GET } = await import('./+server');

function localsWith(avatar: string | undefined) {
	return {
		pb: {
			authStore: { record: avatar === undefined ? null : { id: 'u1', avatar } },
			files: {
				getURL: (_r: unknown, f: string) => `https://pb.example.test/api/files/users/u1/${f}`
			}
		}
	} as any;
}

async function call(locals: any, fetchImpl: any) {
	return GET({ locals, fetch: fetchImpl } as any);
}

describe('avatar proxy', () => {
	beforeEach(() => {
		for (const k of Object.keys(mockEnv)) delete mockEnv[k];
		mockEnv.PB_URL = 'https://pb.example.test';
	});

	// The reason this route exists: PocketBase is behind Access with no public
	// inbound port, and a browser can't present a service token — so the fetch
	// must carry it server-side.
	test('fetches the file with the Access service token attached', async () => {
		mockEnv.CF_ACCESS_CLIENT_ID = 'id-123';
		mockEnv.CF_ACCESS_CLIENT_SECRET = 'secret-456';
		let seenUrl = '';
		let seenHeaders: Record<string, string> = {};
		const res = await call(localsWith('face.png'), (url: string, init: any) => {
			seenUrl = url;
			seenHeaders = init.headers;
			return Promise.resolve(new Response('PNGDATA', { headers: { 'content-type': 'image/png' } }));
		});

		expect(seenUrl).toBe('https://pb.example.test/api/files/users/u1/face.png');
		expect(seenHeaders).toEqual({
			'CF-Access-Client-Id': 'id-123',
			'CF-Access-Client-Secret': 'secret-456'
		});
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('image/png');
		// Private: one user's file behind their session, never a shared cache.
		expect(res.headers.get('cache-control')).toBe('private, max-age=300');
		expect(await res.text()).toBe('PNGDATA');
	});

	test('404s when the user has no avatar', async () => {
		await expect(
			call(localsWith(''), () => Promise.reject(new Error('should not fetch')))
		).rejects.toMatchObject({
			status: 404
		});
	});

	test('404s when there is no signed-in user', async () => {
		await expect(
			call(localsWith(undefined), () => Promise.reject(new Error('should not fetch')))
		).rejects.toMatchObject({ status: 404 });
	});

	// A 403 from upstream means the service token is missing or expired — surface
	// it as a server error rather than a broken image, since the same failure
	// takes the whole app down.
	test('maps an upstream 403 to 502, not a blank image', async () => {
		await expect(
			call(localsWith('face.png'), () => Promise.resolve(new Response('denied', { status: 403 })))
		).rejects.toMatchObject({ status: 502 });
	});

	test('maps an upstream 404 to 404', async () => {
		await expect(
			call(localsWith('gone.png'), () => Promise.resolve(new Response('', { status: 404 })))
		).rejects.toMatchObject({ status: 404 });
	});
});
