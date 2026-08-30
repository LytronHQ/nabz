import { test, expect } from 'vitest';
import { BaseEntityList, PaginationData } from '$lib/models';

type ExampleType = {
	id: string;
	name: string;
};

test('BaseEntityList Test 1', () => {
	const list = new BaseEntityList<ExampleType>(
		[
			{
				id: '1',
				name: 'Example 1'
			}
		],
		new PaginationData({ current: 1, size: 3, totalItems: 0 } as any)
	);

	expect(list.hasItems).toBe(true);
	expect(list.items.length).toBe(1);

	list['add']({ id: '2', name: 'Example 2' });
	expect(list.items.length).toBe(2);

	list['edit']({ id: '2', name: 'Example 2 edited' });
	expect(list.items.length).toBe(2);

	list['remove']('2');
	expect(list.items.length).toBe(1);
});

test('BaseEntityList Test 2', () => {
	const list = new BaseEntityList<ExampleType>(
		[
			{
				id: '1',
				name: 'Example 1'
			}
		],
		new PaginationData({ current: 1, size: 10, totalItems: 0 } as any)
	);

	expect(list.hasItems).toBe(true);
	expect(list.items.length).toBe(1);

	list['add']({ id: '2', name: 'Example 2' });
	list['edit']({ id: '2', name: 'Example 2 edited' });
	list['remove']('2');
	expect(list.items.length).toBe(1);

	expect(list.shouldReload(5)).toBe(false);

	list.updatePagination();
	expect(list.shouldReload(5)).toBe(false);
});

test('BaseEntityList Test 3', () => {
	const items = Array.from({ length: 100 }, (_, i) => ({
		id: i.toString(),
		name: `Example ${i}`
	}));
	const list = new BaseEntityList<ExampleType>(
		items,
		new PaginationData({ current: 1, size: 10, totalItems: 1000 } as any)
	);

	expect(list.hasItems).toBe(true);
	expect(list.items.length).toBe(100);
	expect(list.pagination.current).toBe(1);
	expect(list.pagination.totalItems).toBe(1000);
	expect(list.pagination.totalPages).toBe(100);

	list['remove']('2');
	expect(list.items.length).toBe(99);
});
