import { get, writable } from 'svelte/store';
import { DefaultPageSize, type EntityIdType } from '#lib/constants.js';
import { DependenciesList, type DependencyNewItem } from '#lib/models/dependency.js';
import BaseStore, { isLoaded } from './base-store';
import { pushToast } from '#lib/stores/toast-store.js';
import { friendlyMessage } from '#lib/utils/api-error-utils.js';

const dependencies = writable({} as DependenciesList);
// Bumped by every successful save. A list load that started before a save carries
// data from before it: it ran late once, after an add that had itself thrown on the
// still-unloaded list, so the dialog stayed open over an empty list while the
// alert channel existed (#641). A load that sees the count change fetches again.
let saves = 0;

export default class DependenciesStore extends BaseStore {
	subscribeDependencies = dependencies.subscribe;

	async getAll(
		page: number = 1,
		perPage: number = DefaultPageSize,
		background: boolean = false
	): Promise<void> {
		const started = saves;
		const data = await super.fetch(`/api/dependencies?page=${page}&perPage=${perPage}`, undefined, {
			background
		});
		if (!data) {
			if (!background) pushToast('error', friendlyMessage(this.lastError));
			return;
		}
		if (saves !== started) return this.getAll(page, perPage, background);
		dependencies.set(new DependenciesList(data));
	}

	async add(entity: DependencyNewItem) {
		// Edges are just {from, to}; a JSON body keeps the route simple (the server
		// applies the owner/self-link/duplicate/cycle guards).
		const item = await super.fetch('/api/dependencies', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ from: entity.from, to: entity.to })
		});
		if (!item) return false;

		saves++;
		if (isLoaded(get(dependencies))) dependencies.update((e) => new DependenciesList(e).add(item));
		return true;
	}

	async remove(id: EntityIdType) {
		// DELETE returns 204 (empty body); success is "no error was set".
		await super.fetch(`/api/dependencies/${id}`, { method: 'DELETE' });
		if (this.lastError) return false;
		saves++;
		if (isLoaded(get(dependencies))) dependencies.update((e) => new DependenciesList(e).remove(id));
		return true;
	}
}
