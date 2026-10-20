import { test, expect, vi } from 'vitest';
import { computeUptime24h, COUNTED_CHECKS } from './checks';
import { checkState } from '#lib/utils/format-utils.js';

// #598: a failure the worker blamed on its own network (canaries failed too) is
// no verdict on the site, so uptime leaves it out; any other failure, including
// one seen by a single zone, still counts.
test('the 24h uptime counts only checks that are not inconclusive', async () => {
	const filters: string[] = [];
	const pb = {
		collection: () => ({
			getList: vi.fn(async (_p: number, _n: number, opts: { filter: string }) => {
				filters.push(opts.filter);
				return { totalItems: opts.filter.includes('up=true') ? 9 : 10 };
			})
		})
	} as never;
	expect(await computeUptime24h(pb, 'm1')).toBe(90);
	expect(filters).toHaveLength(2);
	for (const f of filters) expect(f).toContain(COUNTED_CHECKS);
	expect(COUNTED_CHECKS).toBe('inconclusive != true');
});

test('the checks log names an inconclusive failure "not counted"', () => {
	expect(checkState({ up: false, status_code: 0, inconclusive: true })).toBe('not-counted');
	// A genuine failure, from any zone, is still down.
	expect(checkState({ up: false, status_code: 500 })).toBe('down');
	expect(checkState({ up: false, status_code: 0, inconclusive: false })).toBe('down');
	expect(checkState({ up: true, inconclusive: true })).toBe('up');
});
