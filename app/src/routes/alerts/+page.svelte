<script lang="ts">
	import type { EntityIdType } from '$lib/constants';
	import { onMount } from 'svelte';
	import {
		Modal,
		Meta,
		PageHeader,
		Pagination,
		AddButton,
		EmptyState
	} from '$lib/components/common';
	import { Form, List } from '$lib/components/alert-channels';
	import {
		AlertChannelNewItem,
		AlertChannelItem,
		AlertChannelsList
	} from '$lib/models/alert-channel';
	import AlertChannelsStore from '$lib/stores/alert-channels-store';
	import type ApiError from '$lib/models/api-error';
	import { pushToast } from '$lib/stores/toast-store';
	import { friendlyMessage } from '$lib/utils/api-error-utils';
	import { routeSaveError } from '$lib/utils/form-utils';

	let channels: AlertChannelsList | undefined = $state();
	let addModal: Modal | undefined = $state();
	let editModal: Modal | undefined = $state();
	let newItem: AlertChannelNewItem | undefined = $state();
	let editItem: AlertChannelItem | undefined = $state();
	let addErrors: Record<string, string> = $state({});
	let editErrors: Record<string, string> = $state({});

	const store = new AlertChannelsStore();
	let lastError: ApiError | null = null;
	store.subscribeChannels((e) => (channels = e));
	store.subscribeError((e) => (lastError = e));

	let currentPage = 1;
	onMount(() => store.getAll());
	function onPage(detail: { page: number }) {
		currentPage = detail.page;
		store.getAll(currentPage);
	}

	async function submitAdd(): Promise<boolean> {
		addErrors = {};
		const ok = await store.add(newItem!);
		if (ok) {
			pushToast('success', 'Channel added');
			return true;
		}
		addErrors = routeSaveError(lastError);
		return false;
	}
	async function submitEdit(): Promise<boolean> {
		editErrors = {};
		const ok = await store.edit(editItem!);
		if (ok) {
			pushToast('success', 'Channel updated');
			return true;
		}
		editErrors = routeSaveError(lastError);
		return false;
	}

	function openAddModal() {
		newItem = new AlertChannelNewItem();
		addErrors = {};
		addModal!.openModal();
	}
	function openEditModal(detail: { id: EntityIdType }) {
		editItem = channels!.items.filter((e) => e.id === detail.id)[0];
		editErrors = {};
		editModal!.openModal();
	}
	async function removeChannel(detail: { id: EntityIdType }) {
		if (!confirm('Delete this alert channel?')) return;
		const ok = await store.remove(detail.id);
		pushToast(ok ? 'success' : 'error', ok ? 'Channel deleted' : friendlyMessage(lastError));
	}
</script>

<Meta title="Alerts" />

<PageHeader
	title="Alert channels"
	sub="Where to notify when a monitor goes down (confirmed across its zones)"
>
	{#snippet actions()}
		<AddButton label="Add channel" onclick={openAddModal} />
	{/snippet}
</PageHeader>

<div class="relative">
	{#if !channels?.items}
		<div class="card" style="padding:16px">
			<div class="skel"></div>
			<div class="skel"></div>
			<div class="skel" style="width:55%"></div>
		</div>
	{:else if channels!.hasItems}
		<List data={channels!.items} onedit={openEditModal} ondelete={removeChannel} />
		<div style="margin-top:14px">
			<Pagination bind:data={channels!.pagination} onupdate={onPage} />
		</div>
	{:else}
		<EmptyState message="No alert channels yet.">
			{#snippet action()}
				<AddButton label="Add your first channel" onclick={openAddModal} />
			{/snippet}
		</EmptyState>
	{/if}
</div>

<Modal bind:this={addModal} title="Add alert channel" submitText="Add Channel" submit={submitAdd}>
	<Form data={newItem} errors={addErrors} />
</Modal>

<Modal bind:this={editModal} title="Update alert channel" submitText="Save" submit={submitEdit}>
	<Form data={editItem} errors={editErrors} />
</Modal>
