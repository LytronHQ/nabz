import { describe, test, expect, vi } from 'vitest';
import type { Cookies } from '@sveltejs/kit';

// Hermetic: pin the signing key so the cookie roundtrip + IP hash are deterministic.
vi.mock('$env/dynamic/private', () => ({ env: { PKCE_FLOW_ENCRYPTION_KEY: 'test-secret-key' } }));

const { ANON_COOKIE, mintAnonToken, readAnonToken, setAnonCookie, hashIP, validateAnonTarget } =
	await import('./anon');

function mockCookies() {
	const store = new Map<string, string>();
	return {
		store,
		get: (n: string) => store.get(n),
		set: (n: string, v: string) => store.set(n, v),
		delete: (n: string) => store.delete(n),
		getAll: () => [...store].map(([name, value]) => ({ name, value })),
		serialize: () => ''
	} as unknown as Cookies & { store: Map<string, string> };
}

test('mintAnonToken is 48 hex chars and unique', () => {
	const a = mintAnonToken();
	expect(a).toMatch(/^[a-f0-9]{48}$/);
	expect(a).not.toBe(mintAnonToken());
});

test('anon cookie signs + verifies a token roundtrip; tampering/absence yields ""', () => {
	const c = mockCookies();
	const token = mintAnonToken();
	setAnonCookie(c, token);

	// The stored cookie is the encrypted form, not the raw token.
	expect(c.store.get(ANON_COOKIE)).toBeTruthy();
	expect(c.store.get(ANON_COOKIE)).not.toBe(token);
	expect(readAnonToken(c)).toBe(token);

	// Tampered ciphertext → no session.
	c.store.set(ANON_COOKIE, 'not-a-valid-ciphertext');
	expect(readAnonToken(c)).toBe('');

	// Absent cookie → no session.
	expect(readAnonToken(mockCookies())).toBe('');
});

test('hashIP is deterministic, per-IP distinct, and non-reversible-looking', () => {
	expect(hashIP('203.0.113.7')).toBe(hashIP('203.0.113.7'));
	expect(hashIP('203.0.113.7')).not.toBe(hashIP('203.0.113.8'));
	expect(hashIP('203.0.113.7')).toMatch(/^[a-f0-9]{64}$/); // HMAC-SHA256, not the raw IP
	expect(hashIP('203.0.113.7')).not.toContain('203');
});

describe('validateAnonTarget', () => {
	test('accepts public http(s) targets — including public IP literals and fc-domains', () => {
		for (const t of [
			'https://example.com',
			'http://example.com:8080/path?q=1',
			'https://sub.domain.co.uk',
			'https://1.1.1.1',
			'https://fcbarcelona.com' // domain starting "fc" must NOT be mistaken for ULA
		]) {
			expect(validateAnonTarget(t), t).toMatchObject({ ok: true });
		}
	});

	test('rejects non-URLs, non-http schemes, localhost, and private/loopback/CGNAT literals', () => {
		for (const t of [
			'not a url',
			'ftp://example.com',
			'http://localhost',
			'http://api.localhost',
			'http://127.0.0.1',
			'http://10.1.2.3',
			'http://192.168.0.1',
			'http://172.16.0.1',
			'http://169.254.169.254', // cloud metadata
			'http://100.64.0.1', // CGNAT
			'http://[::1]/'
		]) {
			expect(validateAnonTarget(t), t).toMatchObject({ ok: false });
		}
	});
});
