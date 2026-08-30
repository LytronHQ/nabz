<script lang="ts">
	import { onMount } from 'svelte';
	import { Meta, PageHeader, EmptyState } from '$lib/components/common';
	import { ViewTabs } from '$lib/components/monitors';
	import { DependencyGraph } from '$lib/components/dependencies';
	import DependenciesStore from '$lib/stores/dependencies-store';
	import { DependenciesList, DependencyNewItem } from '$lib/models/dependency';
	import type ApiError from '$lib/models/api-error';
	import { pushToast } from '$lib/stores/toast-store';
	import { friendlyMessage } from '$lib/utils/api-error-utils';

	let { data } = $props();

	let deps: DependenciesList | undefined = $state();
	const store = new DependenciesStore();
	let lastError: ApiError | null = null;
	store.subscribeDependencies((e) => (deps = e));
	store.subscribeError((e) => (lastError = e));

	let fromId = $state('');
	let toId = $state('');
	let adding = $state(false);

	onMount(() => store.getAll());

	// The loaded monitor list is the reliable source of names/status for display.
	// Derived so a re-load of this route (invalidate, or navigating back to it)
	// updates the names and status dots instead of rendering the previous load's.
	let byId = $derived(new Map(data.monitors.map((m) => [m.id, m])));
	const nameOf = (id: string) => byId.get(id)?.name ?? id;
	const statusColor = (id: string) => {
		const s = byId.get(id)?.status;
		return s === 'up'
			? 'var(--status-up)'
			: s === 'down'
				? 'var(--status-down)'
				: s === 'paused'
					? 'var(--status-paused)'
					: 'var(--status-pending)';
	};

	let canAdd = $derived(!!fromId && !!toId && fromId !== toId && !adding);
	let enoughMonitors = $derived(data.monitors.length >= 2);
	let edges = $derived((deps?.items ?? []).map((e) => ({ from: e.from, to: e.to })));

	async function add() {
		if (!canAdd) return;
		adding = true;
		const ok = await store.add(new DependencyNewItem({ from: fromId, to: toId }));
		adding = false;
		if (ok) {
			pushToast('success', 'Dependency added');
			fromId = '';
			toId = '';
		} else {
			pushToast('error', friendlyMessage(lastError));
		}
	}

	async function remove(id: string | undefined) {
		if (!id || !confirm('Remove this dependency?')) return;
		const ok = await store.remove(id);
		pushToast(ok ? 'success' : 'error', ok ? 'Dependency removed' : friendlyMessage(lastError));
	}
</script>

<Meta title="Dependencies" />

<PageHeader
	title="Dependencies"
	sub="Map which monitors depend on others — so when one goes down, you can see the blast radius."
/>

<ViewTabs />

{#if !enoughMonitors}
	<EmptyState message="Add at least two monitors before you can link dependencies." />
{:else}
	<!-- The graph shows every monitor from the start (nodes with no edges yet), so
	     you can see them all while linking them up. -->
	<div class="graph">
		<DependencyGraph monitors={data.monitors} {edges} />
	</div>

	<h2 class="section">Manage links</h2>

	<div class="card add">
		<label class="pick">
			<span>Monitor</span>
			<select class="sel" bind:value={fromId} aria-label="Monitor that depends on another">
				<option value="" disabled selected>Select a monitor…</option>
				{#each data.monitors as m (m.id)}
					<option value={m.id}>{m.name}</option>
				{/each}
			</select>
		</label>

		<span class="dep-word">depends on</span>

		<label class="pick">
			<span>Depends on</span>
			<select class="sel" bind:value={toId} aria-label="Monitor it depends on">
				<option value="" disabled selected>Select a monitor…</option>
				{#each data.monitors as m (m.id)}
					<option value={m.id} disabled={m.id === fromId}>{m.name}</option>
				{/each}
			</select>
		</label>

		<button class="btn btn-primary" onclick={add} disabled={!canAdd}>Add</button>
	</div>

	<div class="relative">
		{#if !deps?.items}
			<div class="card" style="padding:16px">
				<div class="skel"></div>
				<div class="skel"></div>
				<div class="skel" style="width:55%"></div>
			</div>
		{:else if deps.hasItems}
			<ul class="edges">
				{#each deps.items as e (e.id)}
					<li class="edge">
						<span class="node">
							<span class="dot" style="background:{statusColor(e.from)}"></span>
							{nameOf(e.from)}
						</span>
						<span class="arrow" aria-label="depends on">→</span>
						<span class="node">
							<span class="dot" style="background:{statusColor(e.to)}"></span>
							{nameOf(e.to)}
						</span>
						<button class="rm" title="Remove dependency" onclick={() => remove(e.id)}>Remove</button
						>
					</li>
				{/each}
			</ul>
		{:else}
			<EmptyState message="No dependencies yet. Add one above." />
		{/if}
	</div>
{/if}

<style>
	.add {
		display: flex;
		align-items: flex-end;
		flex-wrap: wrap;
		gap: 12px;
		padding: 16px;
		margin-bottom: 16px;
	}
	.pick {
		display: flex;
		flex-direction: column;
		gap: 5px;
		flex: 1 1 220px;
		min-width: 180px;
	}
	.pick span {
		font-size: 12px;
		color: var(--text-secondary);
	}
	.sel {
		height: 38px;
		padding: 0 10px;
		border: 1px solid var(--border);
		border-radius: var(--radius-btn);
		background: var(--surface);
		color: var(--text-primary);
		font-size: 13.5px;
	}
	.dep-word {
		padding-bottom: 9px;
		font-size: 12.5px;
		color: var(--text-muted);
		white-space: nowrap;
	}
	.graph {
		margin-bottom: 18px;
	}
	.section {
		font-size: 14px;
		font-weight: 600;
		color: var(--text-secondary);
		margin: 0 0 10px;
	}
	.edges {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.edge {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 11px 14px;
		border: 1px solid var(--border);
		border-radius: var(--radius-btn);
		background: var(--surface);
	}
	.node {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		font-weight: 550;
		color: var(--text-primary);
	}
	.dot {
		width: 9px;
		height: 9px;
		border-radius: 50%;
		display: inline-block;
	}
	.arrow {
		color: var(--brand);
		font-weight: 700;
	}
	.rm {
		margin-left: auto;
		border: 1px solid var(--border);
		background: var(--surface);
		color: var(--text-secondary);
		font-size: 12.5px;
		padding: 4px 10px;
		border-radius: var(--radius-btn);
		cursor: pointer;
	}
	.rm:hover {
		color: var(--status-down);
		border-color: var(--status-down);
	}
</style>
