<script lang="ts">
	import { resolve } from '$app/paths';
	import { invalidateAll, goto } from '$app/navigation';
	import {
		Meta,
		Modal,
		PageHeader,
		Pagination,
		AddButton,
		EmptyState
	} from '$lib/components/common';
	import { PaginationData } from '$lib/models';
	import { pushToast } from '$lib/stores/toast-store';

	let { data } = $props();

	let policies = $derived(data.policies ?? []);
	let channels = $derived((data.channels ?? []).filter((c) => c.enabled));
	let pagination = $derived(new PaginationData(data.pagination as any));
	function onPage(detail: { page: number }) {
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- the path is resolve()d inside this template literal
		goto(`${resolve('/escalations')}?page=${detail.page}`, { noScroll: true });
	}

	let modal: Modal | undefined = $state();
	let editId: string | null = $state(null);
	let name = $state('');
	let steps: { after_minutes: number; channels: string[] }[] = $state([]);
	let saveError = $state('');

	function openNew() {
		editId = null;
		name = '';
		steps = [{ after_minutes: 0, channels: [] }];
		saveError = '';
		modal!.openModal();
	}
	function openEdit(p: (typeof policies)[number]) {
		editId = p.id;
		name = p.name;
		steps = (p.steps ?? []).map((s) => ({
			after_minutes: s.after_minutes ?? 0,
			channels: [...(s.channels ?? [])]
		}));
		if (steps.length === 0) steps = [{ after_minutes: 0, channels: [] }];
		saveError = '';
		modal!.openModal();
	}
	function addLevel() {
		const last = steps[steps.length - 1];
		steps = [...steps, { after_minutes: (last?.after_minutes ?? 0) + 5, channels: [] }];
	}
	function removeLevel(i: number) {
		steps = steps.filter((_, idx) => idx !== i);
	}
	function toggleChannel(i: number, id: string, checked: boolean) {
		const set = new Set(steps[i].channels);
		if (checked) set.add(id);
		else set.delete(id);
		steps[i].channels = [...set];
		steps = steps;
	}

	async function save(): Promise<boolean> {
		saveError = '';
		if (!name.trim()) {
			saveError = 'Name is required';
			return false;
		}
		const url = editId ? `/api/escalation-policies/${editId}` : '/api/escalation-policies';
		try {
			const res = await fetch(url, {
				method: editId ? 'PATCH' : 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ name: name.trim(), steps })
			});
			if (res.ok) {
				await invalidateAll();
				pushToast('success', editId ? 'Policy updated' : 'Policy created');
				return true;
			}
			const e = await res.json().catch(() => ({}));
			saveError = e.error ?? 'Save failed';
			return false;
		} catch {
			saveError = 'Save failed';
			return false;
		}
	}

	async function remove(p: (typeof policies)[number]) {
		if (!confirm(`Delete policy "${p.name}"?`)) return;
		const res = await fetch(`/api/escalation-policies/${p.id}`, { method: 'DELETE' });
		await invalidateAll();
		pushToast(
			res.ok ? 'success' : 'error',
			res.ok ? 'Policy deleted' : "Couldn't delete the policy"
		);
	}

	function levelSummary(s: { after_minutes: number; channels: string[] }): string {
		const when = s.after_minutes === 0 ? 'now' : `+${s.after_minutes}m`;
		const names = (s.channels ?? []).map((id) => channels.find((x) => x.id === id)?.label ?? '?');
		return `${when} → ${names.length ? names.join(', ') : '—'}`;
	}
</script>

<Meta title="Escalation policies" />

<PageHeader
	title="Escalation policies"
	sub="Page more channels over time while an incident stays unacknowledged. Assign one to a monitor in its settings."
>
	{#snippet actions()}
		<AddButton label="New policy" onclick={openNew} />
	{/snippet}
</PageHeader>

{#if policies.length === 0}
	<EmptyState
		message="No escalation policies yet — monitors without one notify all channels once, immediately."
	>
		{#snippet action()}
			<AddButton label="New policy" onclick={openNew} />
		{/snippet}
	</EmptyState>
{:else}
	<div class="pol-list">
		{#each policies as p (p.id)}
			<div class="card" style="padding:16px">
				<div style="display:flex;align-items:center;gap:12px">
					<b style="font-size:15px">{p.name}</b>
					<div class="toolbar" style="margin-left:auto">
						<button type="button" class="btn btn-ghost" onclick={() => openEdit(p)}>Edit</button>
						<button type="button" class="btn btn-ghost" onclick={() => remove(p)}>Delete</button>
					</div>
				</div>
				<div class="mono" style="color:var(--ink-3);font-size:12.5px;margin-top:8px">
					{#each p.steps ?? [] as s, i (i)}L{i + 1}
						{levelSummary(s)}{#if i < (p.steps?.length ?? 0) - 1}
							·
						{/if}{/each}
					{#if (p.steps ?? []).length === 0}(no levels){/if}
				</div>
			</div>
		{/each}
	</div>
	{#if pagination.isVisible}
		<div style="margin-top:14px">
			<Pagination data={pagination} onupdate={onPage} />
		</div>
	{/if}
{/if}

<Modal
	bind:this={modal}
	title={editId ? 'Edit policy' : 'New policy'}
	submitText="Save"
	submit={save}
>
	<div class="pol-form">
		<label class="block">
			<span class="form-lbl">Name</span>
			<input class="form-input mt-1 block w-full" bind:value={name} placeholder="Critical" />
		</label>

		<div>
			<span class="form-lbl">Levels</span>
			{#each steps as s, i (i)}
				<div class="lvl">
					<div class="lvl-head">
						<b>L{i + 1}</b>
						<label
							>After <input type="number" min="0" bind:value={s.after_minutes} class="min-input" /> min</label
						>
						{#if steps.length > 1}
							<button type="button" class="btn btn-ghost lvl-remove" onclick={() => removeLevel(i)}
								>Remove</button
							>
						{/if}
					</div>
					<div class="chans">
						{#each channels as c (c.id)}
							<label class="chan" class:on={s.channels.includes(c.id)}>
								<input
									type="checkbox"
									checked={s.channels.includes(c.id)}
									onchange={(e) => toggleChannel(i, c.id, e.currentTarget.checked)}
								/>
								<span class="box"></span>
								<span class="lbl">{c.label}</span>
							</label>
						{/each}
						{#if channels.length === 0}<span class="mut" style="font-size:12.5px"
								>No enabled channels — add one under Alerts first.</span
							>{/if}
					</div>
				</div>
			{/each}
			<button type="button" class="btn btn-ghost" onclick={addLevel} style="margin-top:8px"
				>+ Add level</button
			>
		</div>

		{#if saveError}<div class="down-txt" style="font-size:12.5px">{saveError}</div>{/if}
	</div>
</Modal>

<style>
	.pol-list {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}
	.pol-form {
		display: flex;
		flex-direction: column;
		gap: 16px;
	}
	.lvl {
		margin-top: 10px;
		padding: 12px;
		border: 1px solid var(--border);
		border-radius: var(--radius-btn);
		background: var(--surface-2);
	}
	.lvl-head {
		display: flex;
		align-items: center;
		gap: 12px;
		font-size: 13.5px;
	}
	.lvl-remove {
		margin-left: auto;
	}
	.min-input {
		width: 64px;
		padding: 3px 6px;
		border: 1px solid var(--border);
		border-radius: var(--radius-btn);
		background: var(--surface);
		color: var(--ink);
		font-size: 13px;
	}
	.chans {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-top: 10px;
	}
	/* Channel picker as selectable chips — the most important part of a level, so
	   give it room and a clear selected state; chips still wrap so many channels
	   fit the dialog. The whole chip is the target; the native checkbox is hidden. */
	.chan {
		display: inline-flex;
		align-items: center;
		gap: 9px;
		max-width: 100%;
		padding: 8px 12px;
		border: 1px solid var(--border);
		border-radius: var(--radius-btn);
		background: var(--surface);
		font-size: 13px;
		color: var(--ink-2);
		cursor: pointer;
		user-select: none;
		transition:
			border-color 0.12s,
			background 0.12s,
			color 0.12s;
	}
	.chan input {
		position: absolute;
		opacity: 0;
		width: 0;
		height: 0;
	}
	.chan .box {
		flex: 0 0 auto;
		width: 16px;
		height: 16px;
		border: 1.5px solid var(--border-strong);
		border-radius: 4px;
		position: relative;
		transition:
			background 0.12s,
			border-color 0.12s;
	}
	.chan .lbl {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.chan:hover {
		border-color: var(--border-strong);
	}
	.chan:focus-within {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	.chan.on {
		border-color: var(--accent);
		background: var(--accent-wash);
		color: var(--ink);
	}
	.chan.on .box {
		background: var(--accent);
		border-color: var(--accent);
	}
	.chan.on .box::after {
		content: '';
		position: absolute;
		left: 5px;
		top: 2px;
		width: 4px;
		height: 8px;
		border: solid var(--brand-contrast);
		border-width: 0 2px 2px 0;
		transform: rotate(45deg);
	}
</style>
