import type { ListResult } from 'pocketbase';
import { z } from 'zod';
import { type EntityIdType } from '#lib/constants.js';
import { type IBaseEntity, BaseEntityList, BaseEntityValidator, PaginationData } from './';

// A dependency is a directed edge: `from` depends on `to` (so if `to` goes down,
// `from` is in the blast radius). Edges are owner-scoped and carry no config.
const schema = z
	.object({
		from: z.string().min(1, 'Pick the monitor that depends on another'),
		to: z.string().min(1, 'Pick the monitor it depends on')
	})
	.refine((v) => v.from !== v.to, { path: ['to'], message: "A monitor can't depend on itself" });

// What the constructors read from: a PocketBase record (optionally with its
// `expand`ed monitors), a DependencyItem being copied, or flat form fields.
export interface DependencyInput {
	id?: EntityIdType;
	from?: string;
	to?: string;
	fromName?: string;
	toName?: string;
	expand?: { from?: { name?: string }; to?: { name?: string } };
}

function toInput(data: FormData | DependencyInput | null | undefined): DependencyInput {
	return data instanceof FormData ? (Object.fromEntries(data) as DependencyInput) : (data ?? {});
}

export class DependencyItem implements IBaseEntity {
	id: EntityIdType;
	from: string;
	to: string;
	// Resolved monitor names, from PB `expand` when present (else empty; callers
	// that have the monitor list can resolve names themselves).
	fromName: string;
	toName: string;

	constructor(data: FormData | DependencyInput | null | undefined) {
		const item = toInput(data);
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

	constructor(data: FormData | DependencyInput | null = null) {
		const item = toInput(data);
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
	constructor(data: DependenciesList | Partial<ListResult<DependencyInput>>) {
		super(
			data instanceof DependenciesList
				? data.items
				: (data?.items ?? []).map((it) => new DependencyItem(it)),
			data instanceof DependenciesList
				? new PaginationData(data.pagination)
				: new PaginationData(data)
		);
	}

	add(item: DependencyInput) {
		super.add(new DependencyItem(item));
		return this;
	}

	remove(id: EntityIdType) {
		super.remove(id);
		return this;
	}
}
