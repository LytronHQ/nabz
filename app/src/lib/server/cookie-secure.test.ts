import { describe, it, expect } from 'vitest';
import { cookieSecure } from './cookie-secure';

describe('cookieSecure (#394)', () => {
	it('falls back to the build mode when unset — unchanged for every environment that has not opted in', () => {
		expect(cookieSecure(undefined, false)).toBe(true); // production build
		expect(cookieSecure(undefined, true)).toBe(false); // vite dev
		expect(cookieSecure('', false)).toBe(true);
		expect(cookieSecure('   ', false)).toBe(true);
	});

	it('lets an HTTP fleet turn it off explicitly', () => {
		// The whole point: a PRODUCTION build (dev=false) served over plain HTTP.
		expect(cookieSecure('false', false)).toBe(false);
		expect(cookieSecure('FALSE', false)).toBe(false);
		expect(cookieSecure(' false ', false)).toBe(false);
		expect(cookieSecure('0', false)).toBe(false);
		expect(cookieSecure('no', false)).toBe(false);
		expect(cookieSecure('off', false)).toBe(false);
	});

	it('treats anything not recognisably false as secure', () => {
		// Failing closed matters here: a typo that silently dropped Secure in
		// production would put the session cookie on the wire with no symptom at
		// all, whereas an over-strict cookie breaks visibly and immediately.
		for (const v of ['true', 'yes', 'on', '1', 'FALSE!', 'nope', 'flase', 'null']) {
			expect(cookieSecure(v, false), v).toBe(true);
		}
	});

	it('an explicit true wins even in a dev build', () => {
		expect(cookieSecure('true', true)).toBe(true);
	});
});
