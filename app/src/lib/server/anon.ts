import { randomBytes, createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import type { Cookies } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import { encrypt, decrypt } from '$lib/cipher-utils';

// Anonymous "try it" session + limits (#269, epic #265).
//
// A signed-out visitor gets one opaque token (no PII) in a signed, HttpOnly cookie
// — the whole identity of their trial monitor until they sign up (then it's
// migrated into `monitors` and cleared, #272). All PB access is mediated by the
// web service account; the cookie only carries the token.

export const ANON_COOKIE = 'anon_session';

// Limits while anonymous.
export const ANON_ALLOWED_TYPE = 'website'; // website-only (also enforced in the schema)
export const ANON_MIN_INTERVAL = 300; // 5 min — keep free-zone load + outbound volume low
export const ANON_MAX_PER_SESSION = 1; // one strong "it works!" moment
export const ANON_MAX_PER_IP_PER_HOUR = 5; // abuse control
export const ANON_TTL_SECONDS = 60 * 60; // 1h — matches the cleanup TTL (#270)

// 48 hex chars from 24 random bytes.
const TOKEN_RE = /^[a-f0-9]{48}$/;

// The cookie is AES-signed with the app key (also used for the OAuth PKCE cookie);
// a dev fallback keeps local/test runs working when it isn't set.
function secret(): string {
	return env.PKCE_FLOW_ENCRYPTION_KEY || 'anon-dev-secret';
}

export function mintAnonToken(): string {
	return randomBytes(24).toString('hex');
}

// Read + verify the token from the signed cookie; '' if absent, tampered, or malformed.
export function readAnonToken(cookies: Cookies): string {
	const raw = cookies.get(ANON_COOKIE);
	if (!raw) return '';
	try {
		const token = decrypt(raw, secret());
		return TOKEN_RE.test(token) ? token : '';
	} catch {
		return '';
	}
}

export function setAnonCookie(cookies: Cookies, token: string): void {
	cookies.set(ANON_COOKIE, encrypt(token, secret()), {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: !dev,
		maxAge: ANON_TTL_SECONDS
	});
}

export function clearAnonCookie(cookies: Cookies): void {
	cookies.delete(ANON_COOKIE, { path: '/' });
}

// HMAC the client IP so the stored value can't be reversed to an address — used
// only for the per-IP rate limit, and deleted with the row within the hour.
export function hashIP(ip: string): string {
	return createHmac('sha256', secret())
		.update(ip || 'unknown')
		.digest('hex');
}

// True when an IP LITERAL is one an untrusted target must not reach. Only applies
// to literals (isIP != 0), so real hostnames like "fcbarcelona.com" are never
// misjudged — those pass through to the worker-side SSRF guard (#268), which
// checks the resolved IP and is the real enforcement.
function blockedIPLiteral(host: string): boolean {
	const v = isIP(host);
	if (v === 4) {
		const p = host.split('.').map(Number);
		return (
			p[0] === 0 ||
			p[0] === 127 ||
			p[0] === 10 ||
			(p[0] === 192 && p[1] === 168) ||
			(p[0] === 169 && p[1] === 254) ||
			(p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
			(p[0] === 100 && p[1] >= 64 && p[1] <= 127) // CGNAT
		);
	}
	if (v === 6) {
		const h = host.toLowerCase();
		return (
			h === '::1' ||
			h === '::' ||
			h.startsWith('fc') ||
			h.startsWith('fd') || // unique-local
			h.startsWith('fe80') || // link-local
			h.startsWith('::ffff:') // IPv4-mapped
		);
	}
	return false;
}

// Lightweight first-line target check for a clear, early error. The authoritative
// SSRF protection is the worker-side guard on the resolved IP (#268).
export function validateAnonTarget(raw: string): { ok: boolean; error?: string } {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return { ok: false, error: 'Enter a valid URL, including https://.' };
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		return { ok: false, error: 'Only http(s) URLs can be monitored.' };
	}
	// url.hostname keeps the brackets around IPv6 literals ("[::1]") — strip them
	// so the literal is classified, not treated as an opaque hostname.
	const host = url.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
	if (!host) return { ok: false, error: 'The URL must include a host.' };
	if (host === 'localhost' || host.endsWith('.localhost') || blockedIPLiteral(host)) {
		return { ok: false, error: 'Private and localhost addresses cannot be monitored.' };
	}
	return { ok: true };
}
