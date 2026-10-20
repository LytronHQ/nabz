import { get, writable } from 'svelte/store';
import { DefaultPageSize, type EntityIdType } from '#lib/constants.js';
import { type MonitorItem, type MonitorNewItem, MonitorsList } from '#lib/models/monitor.js';
import BaseStore, { isLoaded } from './base-store';
import { getFormData } from '#lib/utils/server-form-data-utils.js';
import { pushToast } from '#lib/stores/toast-store.js';
import { friendlyMessage } from '#lib/utils/api-error-utils.js';

const monitors = writable({} as MonitorsList);
// Bumped by every successful save. A list load that started before a save carries
// data from before it: it ran late once, after an add that had itself thrown on the
// still-unloaded list, so the dialog stayed open over an empty list while the
// alert channel existed (#641). A load that sees the count change fetches again.
let saves = 0;

export default class MonitorsStore extends BaseStore {
	subscribeMonitors = monitors.subscribe;

	// `background` polls/refreshes without toggling the loading overlay. A failed
	// fetch returns undefined — keep the current list rather than blanking it;
	// surface a foreground failure as a toast (background stays silent).
	async getAll(
		page: number = 1,
		perPage: number = DefaultPageSize,
		background: boolean = false,
		filters: { q?: string; tags?: string[]; status?: string } = {}
	): Promise<void> {
		const started = saves;
		const qs = new URLSearchParams({ page: String(page), perPage: String(perPage) });
		if (filters.q) qs.set('q', filters.q);
		for (const tag of filters.tags ?? []) qs.append('tag', tag);
		if (filters.status) qs.set('status', filters.status);
		const data = await super.fetch(`/api/monitors?${qs.toString()}`, undefined, { background });
		if (!data) {
			if (!background) pushToast('error', friendlyMessage(this.lastError));
			return;
		}
		if (saves !== started) return this.getAll(page, perPage, background, filters);
		monitors.set(new MonitorsList(data));
	}

	async add(entity: MonitorNewItem) {
		const body = await getFormData(entity);
		const item = await super.fetch('/api/monitors', {
			method: 'POST',
			body
		});

		if (!item) return false;

		saves++;
		if (!isLoaded(get(monitors))) return true;
		const list = new MonitorsList(get(monitors)).add(item);
		if (list.shouldReload(list.pagination.totalItems)) {
			await this.getAll(list.pagination.current, list.pagination.size, true);
		} else {
			list.updatePagination();
			monitors.update(() => list);
		}

		return true;
	}

	async edit(entity: MonitorItem) {
		const body = await getFormData(entity);
		const item = await super.fetch(`/api/monitors/${entity.id}`, {
			method: 'PATCH',
			body
		});

		if (!item) return false;

		saves++;
		if (isLoaded(get(monitors))) monitors.update((e) => new MonitorsList(e).edit(item));
		return true;
	}

	async remove(id: EntityIdType) {
		// DELETE returns 204 (empty body), so success is "no error was set" —
		// don't infer it from the response body.
		await super.fetch(`/api/monitors/${id}`, {
			method: 'DELETE'
		});
		if (this.lastError) return false;

		saves++;
		if (!isLoaded(get(monitors))) return true;
		const list = new MonitorsList(get(monitors)).remove(id);

		if (list.shouldReload(list.pagination.totalItems)) {
			const page = list.pagination.current > 1 ? list.pagination.current - 1 : 1;
			await this.getAll(page, list.pagination.size, true);
		} else {
			list.updatePagination();
			monitors.update(() => list);
		}

		return true;
	}
}
