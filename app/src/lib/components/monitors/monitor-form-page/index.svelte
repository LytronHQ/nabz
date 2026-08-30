<script lang="ts">
	// Roomy dedicated Add/Edit monitor page (#143), replacing the cramped modal.
	// Shared by /monitors/new and /monitors/[id]/edit — the mode is inferred from
	// whether `item` is a MonitorNewItem. Cancel and a successful Save both return
	// to `backHref` (the list for new, the monitor detail for edit).
	import { goto } from '$app/navigation';
	import { PageHeader } from '$lib/components/common';
	import { Form } from '$lib/components/monitors/form';
	import { MonitorNewItem, type MonitorItem } from '$lib/models/monitor';
	import MonitorsStore from '$lib/stores/monitors-store';
	import type ApiError from '$lib/models/api-error';
	import { pushToast } from '$lib/stores/toast-store';
	import { routeSaveError } from '$lib/utils/form-utils';

	interface Props {
		item: MonitorNewItem | MonitorItem;
		availableZones?: { zone: string; label?: string; group?: string; stale: boolean }[];
		availablePolicies?: { id: string; name: string }[];
		title: string;
		submitText: string;
		/** Where Cancel and a successful Save navigate to (list or monitor detail). */
		backHref: string;
	}

	let {
		item,
		availableZones = [],
		availablePolicies = [],
		title,
		submitText,
		backHref
	}: Props = $props();

	// Derived because `item` now is: /monitors/[id]/edit rebuilds it when you
	// navigate between monitors, and a captured flag would describe the previous one.
	let isNew = $derived(item instanceof MonitorNewItem);
	let errors: Record<string, string> = $state({});
	let saving = $state(false);

	const store = new MonitorsStore();
	let lastError: ApiError | null = null;
	store.subscribeError((e) => (lastError = e));

	async function save() {
		errors = {};
		saving = true;
		const ok = isNew
			? await store.add(item as MonitorNewItem)
			: await store.edit(item as MonitorItem);
		saving = false;
		if (ok) {
			pushToast('success', isNew ? 'Monitor added' : 'Monitor updated');
			// eslint-disable-next-line svelte/no-navigation-without-resolve -- backHref is a prop; both callers pass a resolve()d path
			goto(backHref);
			return;
		}
		// 400 validation -> inline field errors; anything else -> a toast.
		errors = routeSaveError(lastError);
	}
	function cancel() {
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- backHref is a prop; both callers pass a resolve()d path
		goto(backHref);
	}
</script>

<PageHeader {title}>
	{#snippet actions()}
		<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- backHref is a prop; both callers pass a resolve()d path -->
		<a class="btn btn-ghost" href={backHref}>Cancel</a>
	{/snippet}
</PageHeader>

<form
	class="card mon-form-card"
	onsubmit={(e) => {
		e.preventDefault();
		save();
	}}
>
	<Form data={item} {availableZones} {availablePolicies} {errors} />
	<div class="mon-form-actions">
		<button type="button" class="btn btn-ghost" onclick={cancel}>Cancel</button>
		<button type="submit" class="btn btn-primary" disabled={saving}>{submitText}</button>
	</div>
</form>

<style>
	.mon-form-card {
		padding: 22px 24px;
		margin-top: 4px;
	}
	.mon-form-actions {
		display: flex;
		justify-content: flex-end;
		gap: 10px;
		margin-top: 22px;
		padding-top: 18px;
		border-top: 1px solid var(--border);
	}
</style>
