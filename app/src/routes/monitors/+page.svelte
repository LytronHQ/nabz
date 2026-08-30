<script lang="ts">
	import { resolve } from '$app/paths';
	import type { EntityIdType } from '$lib/constants';
	import { onMount } from 'svelte';
	import { get } from 'svelte/store';
	import { goto } from '$app/navigation';
	import { usePoll } from '$lib/utils/use-poll';
	import { PageHeader, Pagination, Meta, AddButton, EmptyState } from '$lib/components/common';
	import { List, ViewTabs } from '$lib/components/monitors';
	import { MonitorItem, MonitorsList } from '$lib/models/monitor';
	import MonitorsStore from '$lib/stores/monitors-store';
	import type ApiError from '$lib/models/api-error';
	import { DefaultPageSize } from '$lib/constants';
	import { pushToast } from '$lib/stores/toast-store';
	import { friendlyMessage } from '$lib/utils/api-error-utils';
	import { monitorFilters } from '$lib/stores/list-filters';
	import { parseTagSearch, toggleTag } from '$lib/utils/tag-search';

	let { data } = $props();

	// Seeded from the server load (#118) so the list renders immediately instead of
	// flashing the placeholder while the client fetch resolves.
	// `as any`: MonitorsList's public overload is the copy-constructor; its impl
	// also accepts a raw ListResult (what the load returns), same as the store.
	// This one genuinely must stay $state, unlike the derived reads elsewhere: the
	// store reassigns `monitors` as soon as the client fetch lands, and $derived
	// values cannot be assigned to. `data` is only the initial paint; every later
	// change, pagination included, arrives through the store subscription below.
	// svelte-ignore state_referenced_locally
	let monitors: MonitorsList = $state(new MonitorsList(data.monitors as any));

	const monitorsStore = new MonitorsStore();
	let lastError: ApiError | null = null;
	monitorsStore.subscribeMonitors((e) => {
		// Ignore the store's initial empty emit so it doesn't clobber the
		// server-rendered list; adopt real updates (with uptime) once they arrive.
		if (e?.items) monitors = e;
	});
	monitorsStore.subscribeError((e) => {
		lastError = e;
	});

	let currentPage = 1;

	// Server-side search + filter (scales past the current page).
	let search = $state('');
	let statusFilter = $state('');
	const statusFilters = ['', 'up', 'down', 'pending', 'paused'];
	let searchTimer: ReturnType<typeof setTimeout>;
	let filtering = $state(false);
	let allTags: string[] = $state([]);
	let activeTags = $derived(parseTagSearch(search).tags);

	let hasFilter = $derived(!!(search.trim() || statusFilter));

	// Read the filter state synchronously — a `$:` reactive object would still hold
	// the previous value when called from the same click/ input handler that set it.
	function currentFilters() {
		const { q, tags } = parseTagSearch(search);
		return { q, tags, status: statusFilter || undefined };
	}

	async function reload(page = 1) {
		currentPage = page;
		monitorFilters.set({ q: search, status: statusFilter });
		filtering = true;
		await monitorsStore.getAll(page, DefaultPageSize, false, currentFilters());
		filtering = false;
	}
	function onSearchInput() {
		clearTimeout(searchTimer);
		searchTimer = setTimeout(() => reload(1), 250);
	}
	function setStatus(s: string) {
		statusFilter = s;
		reload(1);
	}
	function toggleTagInSearch(tag: string) {
		search = toggleTag(search, tag);
		reload(1);
	}

	async function loadTags() {
		try {
			const res = await fetch('/api/monitors/tags');
			if (res.ok) allTags = (await res.json()).tags ?? [];
		} catch {
			// non-fatal: the quick-filter list just stays empty
		}
	}

	onMount(() => {
		// Restore filters persisted from a previous visit (#141) before the first fetch.
		const f = get(monitorFilters);
		search = f.q;
		statusFilter = f.status;
		// Background refresh: fills in uptime-24h and enables polling without
		// blanking the server-rendered list.
		monitorsStore.getAll(1, DefaultPageSize, true, currentFilters());
		loadTags();
	});
	// Poll silently in the background so the list refreshes without flashing a
	// loading overlay every 10s — preserving the active search/filter.
	usePoll(() => monitorsStore.getAll(currentPage, DefaultPageSize, true, currentFilters()), 10000);

	function goToEdit(detail: { id: EntityIdType }) {
		goto(resolve('/monitors/[id]/edit', { id: detail.id! }));
	}
	async function removeMonitor(detail: { id: EntityIdType }) {
		if (!confirm('Are you sure you want to delete this monitor?')) return;
		const ok = await monitorsStore.remove(detail.id);
		pushToast(ok ? 'success' : 'error', ok ? 'Monitor deleted' : friendlyMessage(lastError));
	}
	async function togglePause(detail: { id: EntityIdType }) {
		const item = monitors.items.filter((e) => e.id === detail.id)[0];
		if (!item) return;
		const copy = new MonitorItem(item);
		copy.enabled = !copy.enabled;
		const ok = await monitorsStore.edit(copy);
		if (!ok) pushToast('error', friendlyMessage(lastError));
	}
	function currentPageUpdated(detail: { page: number }) {
		currentPage = detail.page;
		monitorsStore.getAll(currentPage, DefaultPageSize, false, currentFilters());
	}
</script>

<Meta title="Monitors" />

<PageHeader
	title="Monitors"
	sub={`${monitors?.items?.length ?? 0} monitor${(monitors?.items?.length ?? 0) === 1 ? '' : 's'}`}
>
	{#snippet actions()}
		<AddButton label="Add monitor" href={resolve('/monitors/new')} />
	{/snippet}
</PageHeader>

<ViewTabs />

<div class="mon-filters">
	<input
		class="form-input mon-search"
		type="search"
		placeholder="Search name, URL, or tag…"
		bind:value={search}
		oninput={onSearchInput}
	/>
	<div class="mon-status">
		{#each statusFilters as s, i (i)}
			<button
				type="button"
				class="mon-pill"
				class:active={statusFilter === s}
				onclick={() => setStatus(s)}
			>
				{s === '' ? 'All' : s}
			</button>
		{/each}
	</div>
	<span class="list-spin" class:on={filtering} aria-hidden="true" title="Filtering…"></span>
</div>
{#if allTags.length}
	<div class="mon-tags">
		{#each allTags as t (t)}
			<button
				type="button"
				class="mon-tagquick"
				class:active={activeTags.includes(t)}
				title={activeTags.includes(t) ? `Remove #${t} from filter` : `Filter by #${t}`}
				onclick={() => toggleTagInSearch(t)}>#{t}</button
			>
		{/each}
	</div>
{/if}

<div class="relative">
	{#if monitors.hasItems}
		<List
			data={monitors.items}
			onedit={goToEdit}
			onpause={togglePause}
			ondelete={removeMonitor}
			ontag={(d) => toggleTagInSearch(d.tag)}
		/>
		<div style="margin-top:14px">
			<Pagination bind:data={monitors.pagination} onupdate={currentPageUpdated} />
		</div>
	{:else if hasFilter}
		<EmptyState message="No monitors match your search or filter.">
			{#snippet action()}
				<button
					type="button"
					class="btn btn-ghost"
					onclick={() => {
						search = '';
						statusFilter = '';
						reload(1);
					}}>Clear filters</button
				>
			{/snippet}
		</EmptyState>
	{:else}
		<EmptyState message="No monitors yet.">
			{#snippet action()}
				<AddButton label="Add your first monitor" href={resolve('/monitors/new')} />
			{/snippet}
		</EmptyState>
	{/if}
</div>

<style>
	.mon-filters {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
		margin-bottom: 14px;
	}
	.mon-search {
		flex: 1 1 240px;
		max-width: 360px;
	}
	.mon-status {
		display: inline-flex;
		gap: 4px;
		flex-wrap: wrap;
	}
	.mon-pill {
		border: 1px solid var(--border);
		background: var(--surface);
		color: var(--ink-2);
		border-radius: var(--radius-pill);
		padding: 4px 11px;
		font-size: 12.5px;
		text-transform: capitalize;
		cursor: pointer;
	}
	.mon-pill.active {
		background: var(--accent-wash);
		color: var(--accent-strong);
		border-color: var(--accent-wash);
	}
	.mon-tags {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin: -8px 0 14px;
	}
	.mon-tagquick {
		border: 1px solid var(--border);
		background: var(--surface);
		color: var(--ink-2);
		border-radius: var(--radius-pill);
		padding: 3px 10px;
		font-size: 12px;
		cursor: pointer;
	}
	.mon-tagquick:hover {
		border-color: var(--border-strong);
		color: var(--ink);
	}
	.mon-tagquick.active {
		background: var(--accent-wash);
		color: var(--accent-strong);
		border-color: var(--accent-wash);
	}
</style>
