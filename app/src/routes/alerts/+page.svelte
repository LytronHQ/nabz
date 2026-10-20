<script lang="ts">
	import type { EntityIdType } from '#lib/constants.js';
	import { onMount } from 'svelte';
	import {
		Modal,
		Meta,
		PageHeader,
		Pagination,
		AddButton,
		EmptyState
	} from '#lib/components/common/index.js';
	import { Form, List } from '#lib/components/alert-channels/index.js';
	import {
		AlertChannelNewItem,
		AlertChannelItem,
		AlertChannelsList
	} from '#lib/models/alert-channel.js';
	import AlertChannelsStore from '#lib/stores/alert-channels-store.js';
	import type ApiError from '#lib/models/api-error.js';
	import { pushToast } from '#lib/stores/toast-store.js';
	import { friendlyMessage } from '#lib/utils/api-error-utils.js';
	import { routeSaveError } from '#lib/utils/form-utils.js';

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
		// A plain copy: Svelte 5 does not make class instances reactive, so with the
		// instance itself, picking another type never swapped the form's fields.
		newItem = { ...new AlertChannelNewItem() };
		addErrors = {};
		addModal!.openModal();
	}
	function openEditModal(detail: { id: EntityIdType }) {
		const found = channels!.items.find((e) => e.id === detail.id);
		// Plain copy for the same reason as newItem, and so Cancel leaves the list alone.
		editItem = found ? { ...found } : undefined;
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
