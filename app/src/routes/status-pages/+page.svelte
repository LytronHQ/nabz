<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { Alert, Meta, PageHeader } from '#lib/components/common/index.js';
	import StatusPageForm from '#lib/components/status-pages/form.svelte';

	let { data, form } = $props();
	let full = $derived(data.pages.length >= data.limit);
	let errors = $derived((form as { errors?: Record<string, string> } | null)?.errors ?? {});
	let values = $derived(
		(
			form as {
				input?: { title: string; slug: string; description: string; monitors: string[] };
			} | null
		)?.input ?? { title: '', slug: '', description: '', monitors: [] }
	);
</script>

<Meta title="Status pages" />

<PageHeader
	title="Status pages"
	sub="Public pages that show the state of the monitors you choose. No sign-in needed to view them."
/>

{#if form?.message}
	<div class="spm-msg">
		<Alert tone={form.success ? 'success' : 'error'}>{form.message}</Alert>
	</div>
{/if}

<div class="card">
	<div class="card__h">
		<h3>Your pages</h3>
		<span class="hint"
			>{data.limited
				? `${data.pages.length} of ${data.limit} on ${data.planName}`
				: `${data.pages.length}`}</span
		>
	</div>
	{#if data.pages.length === 0}
		<p class="spm-empty">No status pages yet.</p>
	{:else}
		<ul class="spm-list">
			{#each data.pages as p (p.id)}
				<li>
					<div class="spm-item">
						<span class="spm-title">{p.title}</span>
						<a
							class="spm-url"
							href={resolve('/s/[slug]', { slug: p.slug })}
							target="_blank"
							rel="noopener">{page.url.origin}/s/{p.slug}</a
						>
					</div>
					<span class="spm-count">{p.count} {p.count === 1 ? 'monitor' : 'monitors'}</span>
					<a class="btn btn-ghost" href={resolve('/status-pages/[id]', { id: p.id })}>Edit</a>
				</li>
			{/each}
		</ul>
	{/if}
</div>

<div class="card">
	<div class="card__h">
		<h3>New status page</h3>
		{#if data.footer}<span class="hint">shows "Powered by nabz" on {data.planName}</span>{/if}
	</div>
	<div class="spm-body">
		{#if full}
			<p class="spm-empty">{data.limitMessage}</p>
		{:else}
			{#key form}
				<form method="POST" action="?/create" use:enhance>
					<StatusPageForm {values} monitors={data.monitors} {errors} origin={page.url.origin} />
					<button
						type="submit"
						class="btn btn-primary spm-submit"
						disabled={data.monitors.length === 0}>Create page</button
					>
				</form>
			{/key}
		{/if}
	</div>
</div>

<style>
	.spm-msg {
		margin-bottom: 14px;
	}
	.spm-empty {
		margin: 0;
		padding: 16px;
		font-size: 14px;
		color: var(--ink-3);
	}
	.spm-body {
		padding: 16px;
	}
	.spm-submit {
		margin-top: 16px;
	}
	.spm-list {
		list-style: none;
		margin: 0;
		padding: 0 16px;
	}
	.spm-list li {
		display: grid;
		grid-template-columns: 1fr auto auto;
		align-items: center;
		gap: 12px;
		padding: 12px 0;
		border-bottom: 1px solid var(--border);
	}
	.spm-list li:last-child {
		border-bottom: 0;
	}
	.spm-item {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}
	.spm-title {
		font-weight: 560;
		color: var(--ink);
		overflow-wrap: anywhere;
	}
	.spm-url {
		font-size: 12.5px;
		color: var(--accent);
		overflow-wrap: anywhere;
	}
	.spm-count {
		font-size: 12.5px;
		color: var(--ink-3);
		white-space: nowrap;
	}
	@media (max-width: 560px) {
		.spm-list li {
			grid-template-columns: 1fr auto;
		}
		.spm-count {
			grid-column: 1;
			grid-row: 2;
		}
		.spm-list li > a.btn {
			grid-column: 2;
			grid-row: 1 / span 2;
		}
	}
</style>
