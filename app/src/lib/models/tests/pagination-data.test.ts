import { test, expect } from 'vitest';
import { PaginationData } from '$lib/models';

test('PaginationData Test 1', () => {
	const pd1 = new PaginationData({ current: 1, size: 3, totalItems: 120 } as any);
	const pd2 = new PaginationData(pd1);

	expect(pd1.current).toBe(pd2.current);
	expect(pd1.size).toBe(pd2.size);
	expect(pd1.totalItems).toBe(pd2.totalItems);
	expect(pd1.totalPages).toBe(pd2.totalPages);
});

test('PaginationData Test 2', () => {
	const pd1 = new PaginationData({ page: 1, perPage: 3, totalItems: 120 } as any);

	expect(pd1.current).toBe(1);
	expect(pd1.size).toBe(3);
	expect(pd1.totalItems).toBe(120);
	expect(pd1.totalPages).toBe(40);
	expect(pd1.isVisible).toBe(true);
	expect(pd1.isNextEnabled).toBe(true);
	expect(pd1.isPreviousEnabled).toBe(false);
});

test('pages() windows many pages instead of listing them all', () => {
	// 34 pages, on page 1: first, 1..3 (current ± 2 clamped), … , last.
	const first = new PaginationData({ current: 1, size: 15, totalItems: 500 } as any);
	expect(first.totalPages).toBe(34);
	expect(first.pages).toEqual([1, 2, 3, '…', 34]);

	// Middle page: first … current±2 … last, no stray ellipsis when adjacent.
	const mid = new PaginationData({ current: 17, size: 15, totalItems: 500 } as any);
	expect(mid.pages).toEqual([1, '…', 15, 16, 17, 18, 19, '…', 34]);

	// Last page.
	const last = new PaginationData({ current: 34, size: 15, totalItems: 500 } as any);
	expect(last.pages).toEqual([1, '…', 32, 33, 34]);

	// Few pages: no ellipsis, no duplicates.
	const few = new PaginationData({ current: 1, size: 10, totalItems: 25 } as any);
	expect(few.pages).toEqual([1, 2, 3]);
});
