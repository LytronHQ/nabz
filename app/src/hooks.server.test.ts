import { describe, it, expect } from 'vitest';
import { isPasswordChangeExempt } from './hooks.server';

// The gate redirects every non-exempt path, so the exemption list IS the
// security boundary: too broad and the gate leaks, too narrow and the user is
// trapped in a redirect loop or cannot sign out.
describe('forced password-change exemptions (#392)', () => {
	it('exempts the change page itself — otherwise the redirect loops forever', () => {
		expect(isPasswordChangeExempt('/change-password')).toBe(true);
	});

	it('exempts leaving and recovering', () => {
		// A user who cannot complete the change must still be able to get out, and
		// one who has forgotten the seeded password needs the reset flow.
		expect(isPasswordChangeExempt('/logout')).toBe(true);
		expect(isPasswordChangeExempt('/signin')).toBe(true);
		expect(isPasswordChangeExempt('/reset-password')).toBe(true);
	});

	it('exempts the OAuth callback, which is mid-sign-in', () => {
		expect(isPasswordChangeExempt('/auth/callback')).toBe(true);
	});

	it("exempts SvelteKit's own data and asset requests", () => {
		// Redirecting these breaks the page instead of guarding it.
		expect(isPasswordChangeExempt('/dashboard/__data.json')).toBe(true);
		expect(isPasswordChangeExempt('/_app/immutable/chunk.js')).toBe(true);
	});

	it('gates every app route, including the landing page', () => {
		for (const p of ['/', '/dashboard', '/monitors', '/incidents', '/admin/usage', '/account']) {
			expect(isPasswordChangeExempt(p), p).toBe(false);
		}
	});

	it('does not exempt a path that merely starts with an exempt word', () => {
		// `/logout-everything` is not `/logout`.
		expect(isPasswordChangeExempt('/logout-everything')).toBe(false);
		expect(isPasswordChangeExempt('/signin-as-someone-else')).toBe(false);
	});
});
