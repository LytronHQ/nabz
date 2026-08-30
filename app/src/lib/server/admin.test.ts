import { describe, it, expect } from 'vitest';
import { isAdmin } from './admin';

describe('isAdmin', () => {
	const allow = 'boss@example.com, ops@example.com';

	it('matches an allowlisted email, case/space-insensitively', () => {
		expect(isAdmin('boss@example.com', allow)).toBe(true);
		expect(isAdmin('  BOSS@Example.com ', allow)).toBe(true);
		expect(isAdmin('ops@example.com', allow)).toBe(true);
	});

	it('rejects a non-allowlisted email', () => {
		expect(isAdmin('random@example.com', allow)).toBe(false);
	});

	it('fails closed: empty/undefined allowlist means nobody is admin', () => {
		expect(isAdmin('boss@example.com', '')).toBe(false);
		expect(isAdmin('boss@example.com', undefined)).toBe(false);
	});

	it('rejects a missing email', () => {
		expect(isAdmin(null, allow)).toBe(false);
		expect(isAdmin(undefined, allow)).toBe(false);
		expect(isAdmin('', allow)).toBe(false);
	});

	it('handles whitespace- and comma-separated lists', () => {
		expect(isAdmin('a@x.io', 'a@x.io b@x.io')).toBe(true);
		expect(isAdmin('b@x.io', 'a@x.io,b@x.io')).toBe(true);
	});
});
