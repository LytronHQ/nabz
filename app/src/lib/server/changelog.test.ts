import { test, expect } from 'vitest';
import { parseChangelog, compareSemverDesc } from './changelog';

test('parses a version heading, secondary date line, and bullets', () => {
	const md = `# Changelog

## v0.1.0

_2026-07-26_

- First thing
- Second thing
`;
	const entries = parseChangelog(md);
	expect(entries).toHaveLength(1);
	expect(entries[0].version).toBe('v0.1.0');
	expect(entries[0].date).toBe('2026-07-26'); // date is secondary metadata, not the heading
	expect(entries[0].html).toContain('<li>First thing</li>');
	expect(entries[0].html).toContain('<li>Second thing</li>');
});

test('orders by semver descending, numerically (v0.1.10 above v0.1.9)', () => {
	const md = `
## v0.1.9

_2026-01-01_

- a

## v0.1.10

_2026-02-01_

- b

## v0.2.0

_2026-03-01_

- c
`;
	expect(parseChangelog(md).map((e) => e.version)).toEqual(['v0.2.0', 'v0.1.10', 'v0.1.9']);
});

test('compareSemverDesc puts higher versions first, comparing numerically', () => {
	expect(compareSemverDesc('v0.2.0', 'v0.1.0')).toBeLessThan(0);
	expect(compareSemverDesc('v0.1.10', 'v0.1.9')).toBeLessThan(0);
	expect(compareSemverDesc('v0.1.0', 'v0.1.0')).toBe(0);
});

test('a single version entry is enough to have content (no threshold)', () => {
	// The page/link show as soon as there's >= 1 version entry.
	expect(parseChangelog(`## v0.1.0\n_2026-07-26_\n- x\n`).length).toBe(1);
	expect(parseChangelog('').length).toBe(0);
});

test('old date-only headings are no longer counted as entries', () => {
	// `## YYYY-MM-DD` is not a version heading anymore.
	expect(parseChangelog('## 2026-07-25\n\n- was live\n')).toHaveLength(0);
});

test('a non-date status line (unreleased/in-progress) is captured verbatim', () => {
	const md = `## v0.4.0

_Unreleased — in progress_

- Some upcoming thing
`;
	const entries = parseChangelog(md);
	expect(entries).toHaveLength(1);
	expect(entries[0].date).toBe('Unreleased — in progress');
	expect(entries[0].html).toContain('<li>Some upcoming thing</li>');
});
