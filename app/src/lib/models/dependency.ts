import type { ListResult, RecordModel } from 'pocketbase';
import { z } from 'zod';
import { type EntityIdType } from '$lib/constants';
import { type IBaseEntity, BaseEntityList, BaseEntityValidator, PaginationData } from './';

// A dependency is a directed edge: `from` depends on `to` (so if `to` goes down,
// `from` is in the blast radius). Edges are owner-scoped and carry no config.
const schema = z
	.object({
		from: z.string().min(1, 'Pick the monitor that depends on another'),
		to: z.string().min(1, 'Pick the monitor it depends on')
	})
	.refine((v) => v.from !== v.to, { path: ['to'], message: "A monitor can't depend on itself" });

export class DependencyItem implements IBaseEntity {
	id: EntityIdType;
	from: string;
	to: string;
	// Resolved monitor names, from PB `expand` when present (else empty; callers
	// that have the monitor list can resolve names themselves).
	fromName: string;
	toName: string;

	constructor(data: FormData | RecordModel | any) {
		const item = data instanceof FormData ? Object.fromEntries(data) : (data ?? {});
		this.id = item.id;
		this.from = item.from ?? '';
		this.to = item.to ?? '';
		this.fromName = item.expand?.from?.name ?? item.fromName ?? '';
		this.toName = item.expand?.to?.name ?? item.toName ?? '';
	}
}

export class DependencyNewItem {
	from: string;
	to: string;

	constructor(data: FormData | RecordModel | any = null) {
		const item = data instanceof FormData ? Object.fromEntries(data) : (data ?? {});
		this.from = item.from ?? '';
		this.to = item.to ?? '';
	}
}

export class DependencyItemValidator extends BaseEntityValidator {
	constructor(item: DependencyItem | DependencyNewItem) {
		super(schema, item);
	}
}

export class DependenciesList extends BaseEntityList<DependencyItem> {
	constructor(data: DependenciesList);
	constructor(data: ListResult<RecordModel> | any) {
		super(
			data instanceof DependenciesList
				? data.items
				: (data?.items ?? []).map((it: any) => new DependencyItem(it)),
			data instanceof DependenciesList
				? new PaginationData(data.pagination)
				: new PaginationData(data)
		);
	}

	add(item: any) {
		super.add(new DependencyItem(item));
		return this;
	}

	remove(id: EntityIdType) {
		super.remove(id);
		return this;
	}
}
