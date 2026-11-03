import { randomBytes, createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import type { Cookies } from '@sveltejs/kit';
import { dev } from '$app/env';
import { PKCE_FLOW_ENCRYPTION_KEY } from '$app/env/private';
import { encrypt, decrypt } from '#lib/cipher-utils.js';

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
export const ANON_MAX_PER_IP_PER_HOUR = 5; // abuse control, per network (ipBucket)
// The free zone checks every live trial, so their total is bounded too (#671).
export const ANON_MAX_LIVE = 500;
export const ANON_TTL_SECONDS = 60 * 60; // 1h — matches the cleanup TTL (#270)

// 48 hex chars from 24 random bytes.
const TOKEN_RE = /^[a-f0-9]{48}$/;

// The cookie is AES-sealed and IPs are HMAC'd with a key DERIVED from the app
// key, not the app key itself: the same raw key also seals the OAuth cookie, and
// when it leaked (#580) it opened both. A dev fallback keeps local/test runs working.
function secret(): string {
	const base = PKCE_FLOW_ENCRYPTION_KEY || 'anon-dev-secret';
	return createHmac('sha256', base).update('nabz-anon-session-v1').digest('hex');
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

// ipBucket is what the per-network limit counts by (#671). One IPv6 subscriber
// usually holds a whole /64, so a per-address key gave one client 2^64 budgets.
// IPv4 and IPv4-mapped IPv6 stay per address, so IPv4 clients are never merged.
export function ipBucket(ip: string): string {
	const addr = (ip || '').split('%')[0].toLowerCase();
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
	if (mapped) return mapped[1];
	if (isIP(addr) !== 6) return addr || 'unknown';
	const groups = (s: string): string[] =>
		(s ? s.split(':') : []).flatMap((g) => {
			if (!g.includes('.')) return [g];
			const p = g.split('.').map(Number);
			return [((p[0] << 8) | p[1]).toString(16), ((p[2] << 8) | p[3]).toString(16)];
		});
	const dbl = addr.indexOf('::');
	const head = groups(dbl === -1 ? addr : addr.slice(0, dbl));
	const tail = dbl === -1 ? [] : groups(addr.slice(dbl + 2));
	const all =
		dbl === -1 ? head : [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail];
	return (
		all
			.slice(0, 4)
			.map((g) => g.padStart(4, '0'))
			.join(':') + '::/64'
	);
}

// HMAC the client network so the stored value can't be reversed to an address —
// used only for the per-network rate limit, and deleted with the row within the hour.
export function hashIP(ip: string): string {
	return createHmac('sha256', secret()).update(ipBucket(ip)).digest('hex');
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
			(p[0] === 100 && p[1] >= 64 && p[1] <= 127)
		);
		// CGNAT
	}
	if (v === 6) {
		const h = host.toLowerCase();

		return (
			h === '::1' ||
			h === '::' ||
			h.startsWith('fc') ||
			h.startsWith('fd') || // unique-local
			h.startsWith('fe80') || // link-local
			h.startsWith('::ffff:')
		);
		// IPv4-mapped
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
