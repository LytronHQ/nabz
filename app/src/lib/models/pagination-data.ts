// What the constructor reads from when not copying a PaginationData: a raw
// PocketBase ListResult ({ page, perPage, totalItems }) or a load's
// { current, size, totalItems }.
export interface PaginationInput {
	current?: number;
	size?: number;
	page?: number;
	perPage?: number;
	totalItems?: number;
}

export default class PaginationData {
	current: number;
	size: number;
	totalItems: number;
	get totalPages() {
		return Math.ceil(this.totalItems / this.size);
	}

	constructor(result: PaginationData | PaginationInput) {
		if (result instanceof PaginationData) {
			this.current = result.current;
			this.size = result.size;
			this.totalItems = result.totalItems;
			return;
		}

		// Asserted, not defaulted: an uninitialised store passes `{}`, and these
		// have always stayed undefined in that case.
		this.current = (result.current ?? result.page) as number;
		this.size = (result.size ?? result.perPage) as number;
		this.totalItems = result.totalItems as number;
	}

	get isVisible() {
		return this.totalPages > 1;
	}

	/**
	 * A compact list of page numbers for the pager: always the first and last
	 * page, plus the current page ± 2, with '…' markers filling any gaps. Keeps
	 * the control usable when there are many pages instead of rendering one
	 * button per page.
	 */
	get pages(): (number | '…')[] {
		const total = this.totalPages;
		const wanted = new Set<number>([1, total]);
		for (let p = this.current - 2; p <= this.current + 2; p++) {
			if (p >= 1 && p <= total) wanted.add(p);
		}
		const out: (number | '…')[] = [];
		let prev = 0;
		for (const p of [...wanted].sort((a, b) => a - b)) {
			if (p - prev > 1) out.push('…');
			out.push(p);
			prev = p;
		}
		return out;
	}

	get isNextEnabled() {
		return this.current < this.totalPages;
	}

	get isPreviousEnabled() {
		return this.current > 1;
	}
}
