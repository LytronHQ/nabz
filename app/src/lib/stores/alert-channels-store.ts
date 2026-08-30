import { get, writable } from 'svelte/store';
import { DefaultPageSize, type EntityIdType } from '$lib/constants';
import {
	type AlertChannelItem,
	type AlertChannelNewItem,
	AlertChannelsList
} from '$lib/models/alert-channel';
import BaseStore from './base-store';
import { getFormData } from '$lib/utils/server-form-data-utils';
import { pushToast } from '$lib/stores/toast-store';
import { friendlyMessage } from '$lib/utils/api-error-utils';

const channels = writable({} as AlertChannelsList);

export default class AlertChannelsStore extends BaseStore {
	subscribeChannels = channels.subscribe;

	async getAll(page: number = 1, perPage: number = DefaultPageSize, background: boolean = false) {
		const data = await super.fetch(
			`/api/alert-channels?page=${page}&perPage=${perPage}`,
			undefined,
			{ background }
		);
		if (!data) {
			if (!background) pushToast('error', friendlyMessage(this.lastError));
			return;
		}
		channels.set(new AlertChannelsList(data));
	}

	async add(entity: AlertChannelNewItem) {
		const body = await getFormData(entity);
		const item = await super.fetch('/api/alert-channels', { method: 'POST', body });
		if (!item) return false;

		channels.update((e) => new AlertChannelsList(e).add(item));
		return true;
	}

	async edit(entity: AlertChannelItem) {
		const body = await getFormData(entity);
		const item = await super.fetch(`/api/alert-channels/${entity.id}`, { method: 'PATCH', body });
		if (!item) return false;

		channels.update((e) => new AlertChannelsList(e).edit(item));
		return true;
	}

	async remove(id: EntityIdType) {
		// DELETE returns 204 (empty body); success is "no error was set".
		await super.fetch(`/api/alert-channels/${id}`, { method: 'DELETE' });
		if (this.lastError) return false;
		channels.update((e) => new AlertChannelsList(e).remove(id));
		return true;
	}
}
