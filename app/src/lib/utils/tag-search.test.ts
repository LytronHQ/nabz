import { test, expect } from 'vitest';
import { parseTagSearch, toggleTag } from './tag-search';

test('parseTagSearch splits free text from every #tag', () => {
	expect(parseTagSearch('api')).toEqual({ q: 'api', tags: [] });
	expect(parseTagSearch('#prod')).toEqual({ q: undefined, tags: ['prod'] });
	expect(parseTagSearch('checkout #prod')).toEqual({ q: 'checkout', tags: ['prod'] });
	expect(parseTagSearch('#prod api gateway')).toEqual({ q: 'api gateway', tags: ['prod'] });
	// every #tag filters (ANDed), and duplicates collapse
	expect(parseTagSearch('#prod #api')).toEqual({ q: undefined, tags: ['prod', 'api'] });
	expect(parseTagSearch('#prod #prod')).toEqual({ q: undefined, tags: ['prod'] });
	expect(parseTagSearch('web #prod #api')).toEqual({ q: 'web', tags: ['prod', 'api'] });
	expect(parseTagSearch('   ')).toEqual({ q: undefined, tags: [] });
});

test('toggleTag adds when absent and removes when present', () => {
	expect(toggleTag('', 'prod')).toBe('#prod');
	expect(toggleTag('api', 'prod')).toBe('api #prod');
	expect(toggleTag('api #prod', 'prod')).toBe('api'); // present -> removed
	expect(toggleTag('#prod #api', 'prod')).toBe('#api'); // removes only the matched tag
});
