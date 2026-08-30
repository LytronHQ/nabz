import { writable } from 'svelte/store';
import { DefaultPageSize, type EntityIdType } from '$lib/constants';
import { DependenciesList, type DependencyNewItem } from '$lib/models/dependency';
import BaseStore from './base-store';
import { pushToast } from '$lib/stores/toast-store';
import { friendlyMessage } from '$lib/utils/api-error-utils';

const dependencies = writable({} as DependenciesList);

export default class DependenciesStore extends BaseStore {
	subscribeDependencies = dependencies.subscribe;

	async getAll(page: number = 1, perPage: number = DefaultPageSize, background: boolean = false) {
		const data = await super.fetch(`/api/dependencies?page=${page}&perPage=${perPage}`, undefined, {
			background
		});
		if (!data) {
			if (!background) pushToast('error', friendlyMessage(this.lastError));
			return;
		}
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

		dependencies.update((e) => new DependenciesList(e).add(item));
		return true;
	}

	async remove(id: EntityIdType) {
		// DELETE returns 204 (empty body); success is "no error was set".
		await super.fetch(`/api/dependencies/${id}`, { method: 'DELETE' });
		if (this.lastError) return false;
		dependencies.update((e) => new DependenciesList(e).remove(id));
		return true;
	}
}
