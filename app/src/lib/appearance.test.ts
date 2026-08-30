import { test, expect, vi, afterEach } from 'vitest';
import { resolvedDark } from './appearance';

function mockPrefersDark(matches: boolean) {
	vi.stubGlobal('matchMedia', (query: string) => ({
		matches,
		media: query,
		addEventListener: () => {},
		removeEventListener: () => {}
	}));
}

afterEach(() => {
	vi.unstubAllGlobals();
});

test('resolvedDark: explicit dark/light ignore the OS preference', () => {
	expect(resolvedDark('dark')).toBe(true);
	expect(resolvedDark('light')).toBe(false);
});

test('resolvedDark: system follows the OS preference', () => {
	mockPrefersDark(true);
	expect(resolvedDark('system')).toBe(true);
	mockPrefersDark(false);
	expect(resolvedDark('system')).toBe(false);
});
