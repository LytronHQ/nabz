<script lang="ts">
	// Roomy dedicated Add/Edit monitor page (#143), replacing the cramped modal.
	// Shared by /monitors/new and /monitors/[id]/edit — the mode is inferred from
	// whether `item` is a MonitorNewItem. Cancel and a successful Save both return
	// to `backHref` (the list for new, the monitor detail for edit).
	import { goto } from '$app/navigation';
	import { PageHeader } from '#lib/components/common/index.js';
	import { Form } from '#lib/components/monitors/form/index.js';
	import { MonitorNewItem, type MonitorItem } from '#lib/models/monitor.js';
	import MonitorsStore from '#lib/stores/monitors-store.js';
	import type ApiError from '#lib/models/api-error.js';
	import { pushToast } from '#lib/stores/toast-store.js';
	import { routeSaveError } from '#lib/utils/form-utils.js';

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

	// What the form edits: a PLAIN copy of `item`, held in $state. Svelte 5 makes
	// plain objects deeply reactive but not class instances, and `item` is a
	// MonitorNewItem / MonitorItem — handed to the form as-is, changing the type
	// changed the value but never re-rendered the fields that depend on it. The
	// edit page wraps this component in {#key} on the monitor id, so a navigation
	// to another monitor remounts it with a fresh copy.
	// svelte-ignore state_referenced_locally
	let form = $state({ ...item });
	let errors: Record<string, string> = $state({});
	let saving = $state(false);

	const store = new MonitorsStore();
	let lastError: ApiError | null = null;
	store.subscribeError((e) => (lastError = e));

	async function save() {
		errors = {};
		saving = true;
		const ok = isNew
			? await store.add(form as MonitorNewItem)
			: await store.edit(form as MonitorItem);
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
	<Form data={form} {isNew} {availableZones} {availablePolicies} {errors} />
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
