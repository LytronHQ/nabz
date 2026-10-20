import { get, writable } from 'svelte/store';
import { DefaultPageSize, type EntityIdType } from '#lib/constants.js';
import {
	type AlertChannelItem,
	type AlertChannelNewItem,
	AlertChannelsList
} from '#lib/models/alert-channel.js';
import BaseStore, { isLoaded } from './base-store';
import { getFormData } from '#lib/utils/server-form-data-utils.js';
import { pushToast } from '#lib/stores/toast-store.js';
import { friendlyMessage } from '#lib/utils/api-error-utils.js';

const channels = writable({} as AlertChannelsList);
// Bumped by every successful save. A list load that started before a save carries
// data from before it: it ran late once, after an add that had itself thrown on the
// still-unloaded list, so the dialog stayed open over an empty list while the
// channel existed (#641). A load that sees the count change fetches again.
let saves = 0;

export default class AlertChannelsStore extends BaseStore {
	subscribeChannels = channels.subscribe;

	async getAll(
		page: number = 1,
		perPage: number = DefaultPageSize,
		background: boolean = false
	): Promise<void> {
		const started = saves;
		const data = await super.fetch(
			`/api/alert-channels?page=${page}&perPage=${perPage}`,
			undefined,
			{ background }
		);
		if (!data) {
			if (!background) pushToast('error', friendlyMessage(this.lastError));
			return;
		}
		if (saves !== started) return this.getAll(page, perPage, background);
		channels.set(new AlertChannelsList(data));
	}

	async add(entity: AlertChannelNewItem) {
		const body = await getFormData(entity);
		const item = await super.fetch('/api/alert-channels', { method: 'POST', body });
		if (!item) return false;

		saves++;
		if (isLoaded(get(channels))) channels.update((e) => new AlertChannelsList(e).add(item));
		return true;
	}

	async edit(entity: AlertChannelItem) {
		const body = await getFormData(entity);
		const item = await super.fetch(`/api/alert-channels/${entity.id}`, { method: 'PATCH', body });
		if (!item) return false;

		saves++;
		if (isLoaded(get(channels))) channels.update((e) => new AlertChannelsList(e).edit(item));
		return true;
	}

	async remove(id: EntityIdType) {
		// DELETE returns 204 (empty body); success is "no error was set".
		await super.fetch(`/api/alert-channels/${id}`, { method: 'DELETE' });
		if (this.lastError) return false;
		saves++;
		if (isLoaded(get(channels))) channels.update((e) => new AlertChannelsList(e).remove(id));
		return true;
	}
}
