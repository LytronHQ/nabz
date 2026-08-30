import type { EntityIdType } from '$lib/constants';
import type { IBaseEntity, PaginationData } from '.';

export default class BaseEntityList<T extends IBaseEntity> {
	constructor(
		public items: T[],
		public pagination: PaginationData
	) {}

	get hasItems() {
		return this.items.length > 0;
	}

	protected add(item: T) {
		this.items.push(item);
	}

	protected edit(item: T) {
		this.items = this.items.map((it) => (it.id === item.id ? item : it));
	}

	protected remove(id: EntityIdType) {
		this.items = this.items.filter((it) => it.id !== id);
	}

	public shouldReload(oldCount: number) {
		const oldPageCount = Math.ceil(oldCount / this.pagination.size);
		const newPageCount = Math.ceil(this.items.length / this.pagination.size);
		return oldPageCount !== newPageCount;
	}

	public updatePagination() {
		this.pagination.totalItems = this.items.length;
	}
}
