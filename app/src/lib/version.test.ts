import { test, expect } from 'vitest';
import { formatVersion, APP_VERSION, APP_COMMIT, VERSION_LABEL } from './version';

// The nodes print `v0.11.1 (71ed8c6)`; the web has to read the same way so the
// two halves can be compared at a glance (#489).
test('formats like the Go nodes: version and short commit', () => {
	expect(formatVersion('0.11.1', '71ed8c6f00ba')).toBe('v0.11.1 (71ed8c6)');
});

test('a build without a commit shows the version alone', () => {
	expect(formatVersion('0.11.1', '')).toBe('v0.11.1');
});

test('the version is the repo-root VERSION file, not a copy', async () => {
	const { readFileSync } = await import('node:fs');
	const { resolve } = await import('node:path');
	// vitest runs from app/; the jsdom environment gives import.meta.url no file: scheme.
	const root = readFileSync(resolve(process.cwd(), '../VERSION'), 'utf8').trim();
	expect(APP_VERSION).toBe(root);
	expect(VERSION_LABEL).toBe(formatVersion(APP_VERSION, APP_COMMIT));
});
