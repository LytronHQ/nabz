import { describe, test, expect, vi, beforeEach } from 'vitest';

// Mutable so each test can set the Access token (or not) before importing.
const mockEnv: Record<string, string | undefined> = {};
vi.mock('$env/dynamic/private', () => ({ env: mockEnv }));

const { accessHeaders, createPocketBase } = await import('./pb-client');

describe('accessHeaders', () => {
	beforeEach(() => {
		for (const k of Object.keys(mockEnv)) delete mockEnv[k];
		mockEnv.PB_URL = 'https://pb.example.test';
	});

	test('sends the Cloudflare Access service token when configured', () => {
		mockEnv.CF_ACCESS_CLIENT_ID = 'id-123';
		mockEnv.CF_ACCESS_CLIENT_SECRET = 'secret-456';
		expect(accessHeaders()).toEqual({
			'CF-Access-Client-Id': 'id-123',
			'CF-Access-Client-Secret': 'secret-456'
		});
	});

	// Dev and the self-hosted web VM reach PocketBase directly, with no Access in
	// the path. Sending half a token would be worse than sending none.
	test('sends nothing when only one half is set', () => {
		mockEnv.CF_ACCESS_CLIENT_ID = 'id-123';
		expect(accessHeaders()).toEqual({});
		delete mockEnv.CF_ACCESS_CLIENT_ID;
		mockEnv.CF_ACCESS_CLIENT_SECRET = 'secret-456';
		expect(accessHeaders()).toEqual({});
	});

	test('sends nothing when unset', () => {
		expect(accessHeaders()).toEqual({});
	});
});

describe('createPocketBase', () => {
	beforeEach(() => {
		for (const k of Object.keys(mockEnv)) delete mockEnv[k];
		mockEnv.PB_URL = 'https://pb.example.test';
	});

	// The whole design rests on this: if the token is not attached to outgoing
	// requests, Access rejects every one of them and the app is down.
	test('attaches the Access headers to outgoing requests', async () => {
		mockEnv.CF_ACCESS_CLIENT_ID = 'id-123';
		mockEnv.CF_ACCESS_CLIENT_SECRET = 'secret-456';
		const pb = createPocketBase();
		expect(pb.beforeSend).toBeTypeOf('function');

		const result = await pb.beforeSend!('https://pb.example.test/api/health', {
			headers: { 'X-Existing': 'kept' }
		});
		expect(result.options?.headers).toEqual({
			'X-Existing': 'kept',
			'CF-Access-Client-Id': 'id-123',
			'CF-Access-Client-Secret': 'secret-456'
		});
	});

	test('installs no hook when there is no token', () => {
		expect(createPocketBase().beforeSend).toBeUndefined();
	});

	test('points at PB_URL with auto-cancellation off', () => {
		const pb = createPocketBase();
		expect(pb.baseURL).toBe('https://pb.example.test');
		// Parallel same-collection queries (dashboard counts, /admin/usage) would
		// otherwise be aborted as duplicates.
		expect(pb.autoCancellation).toBeTypeOf('function');
	});
});
