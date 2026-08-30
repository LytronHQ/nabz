<script lang="ts">
	import { resolve } from '$app/paths';
	import { onMount } from 'svelte';
	import { invalidateAll, goto } from '$app/navigation';
	import { usePoll } from '$lib/utils/use-poll';
	import { navigating } from '$app/stores';
	import { get } from 'svelte/store';
	import { Meta, PageHeader, Pagination, Pill, EmptyState } from '$lib/components/common';
	import { PaginationData } from '$lib/models';
	import { incidentFilter } from '$lib/stores/list-filters';
	import { formatRelativeTime, formatDuration, durationSeconds } from '$lib/utils/format-utils';

	let { data } = $props();

	let incidents = $derived(data.incidents ?? []);
	let filter = $derived((data.filter ?? 'all') as 'all' | 'open' | 'resolved');
	let openCount = $derived(data.openCount ?? 0);
	let totalCount = $derived(data.totalCount ?? 0);
	// `as any`: PaginationData's public overload is the copy-constructor; its impl
	// also accepts a raw { current, size, totalItems } (what the load returns).
	let pagination = $derived(new PaginationData(data.pagination as any));

	function setFilter(f: 'all' | 'open' | 'resolved') {
		// Persist across navigation (#141), then reset to page 1 (no page param).
		incidentFilter.set(f);
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- the path is resolve()d inside this template literal
		goto(f === 'all' ? resolve('/incidents') : `${resolve('/incidents')}?filter=${f}`, {
			noScroll: true,
			keepFocus: true
		});
	}
	function onPage(detail: { page: number }) {
		const params = new URLSearchParams();
		params.set('page', String(detail.page));
		if (filter !== 'all') params.set('filter', filter);
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- the path is resolve()d inside this template literal
		goto(`${resolve('/incidents')}?${params}`, { noScroll: true });
	}

	onMount(() => {
		// Restore the filter persisted from a previous visit (#141): the sidebar link
		// is param-less, so a nav-back lands on filter-less 'all' — re-apply the store.
		const stored = get(incidentFilter);
		if (stored !== 'all' && (data.filter ?? 'all') === 'all') {
			// eslint-disable-next-line svelte/no-navigation-without-resolve -- the path is resolve()d inside this template literal
			goto(`${resolve('/incidents')}?filter=${stored}`, {
				noScroll: true,
				keepFocus: true,
				replaceState: true
			});
		}
	});
	usePoll(() => invalidateAll(), 15000);
</script>

<Meta title="Incidents" />

<PageHeader title="Incidents" sub={`${openCount} open · ${totalCount} total`}>
	{#snippet actions()}
		<span class="list-spin" class:on={!!$navigating} aria-hidden="true" title="Loading…"></span>
		<div class="seg">
			<button class:on={filter === 'all'} onclick={() => setFilter('all')}>All</button>
			<button class:on={filter === 'open'} onclick={() => setFilter('open')}>Open</button>
			<button class:on={filter === 'resolved'} onclick={() => setFilter('resolved')}
				>Resolved</button
			>
		</div>
	{/snippet}
</PageHeader>

<div class="card" style="padding:0">
	{#each incidents as inc (inc.id)}
		<div class="inc {inc.resolved_at ? 'res' : 'crit'}">
			<div class="stripe"></div>
			<div class="body">
				<div class="row1">
					{#if inc.resolved_at}
						<Pill tone="up" label="Resolved" />
					{:else}
						<Pill tone="down" live label="Down" />
					{/if}
					<h3>
						<a
							href={resolve('/incidents/[id]', { id: inc.id })}
							style="color:inherit;text-decoration:none">{inc.monitor}</a
						>
					</h3>
					{#if inc.resolved_at}
						<span class="dur mut"
							>{formatDuration(durationSeconds(inc.started_at, inc.resolved_at))}</span
						>
					{:else}
						<span class="dur down-txt"
							>● {formatDuration(durationSeconds(inc.started_at, null))} ongoing</span
						>
					{/if}
				</div>
				<div class="row2">
					<span><b>Monitor</b> {inc.monitor}</span>
					{#if inc.cause}<span><b>Cause</b> {inc.cause}</span>{/if}
					<span><b>Started</b> {formatRelativeTime(inc.started_at)}</span>
					{#if inc.resolved_at}<span><b>Resolved</b> {formatRelativeTime(inc.resolved_at)}</span
						>{/if}
				</div>
			</div>
		</div>
	{/each}
	{#if incidents.length === 0}
		<EmptyState
			card={false}
			message={filter === 'all' ? 'No incidents yet.' : `No ${filter} incidents.`}
		>
			{#snippet icon()}
				<Pill tone="up" label="All clear" />
			{/snippet}
		</EmptyState>
	{/if}
</div>

{#if pagination.isVisible}
	<div style="margin-top:14px">
		<Pagination data={pagination} onupdate={onPage} />
	</div>
{/if}
