<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { Alert, Meta, PageHeader } from '#lib/components/common/index.js';
	import StatusPageForm from '#lib/components/status-pages/form.svelte';

	let { data, form } = $props();
	let errors = $derived((form as { errors?: Record<string, string> } | null)?.errors ?? {});
	let values = $derived(
		(
			form as {
				input?: { title: string; slug: string; description: string; monitors: string[] };
			} | null
		)?.input ?? data.statusPage
	);
</script>

<Meta title={`Edit ${data.statusPage.title}`} />

<PageHeader title={`Edit ${data.statusPage.title}`}>
	{#snippet actions()}
		<a class="btn btn-ghost" href={resolve('/status-pages')}>Back</a>
		<a
			class="btn btn-ghost"
			href={resolve('/s/[slug]', { slug: data.statusPage.slug })}
			target="_blank"
			rel="noopener">View page</a
		>
	{/snippet}
</PageHeader>

{#if form?.message}
	<div class="spe-msg">
		<Alert tone={form.success ? 'success' : 'error'}>{form.message}</Alert>
	</div>
{/if}

<div class="card">
	<div class="spe-body">
		{#key form}
			<form method="POST" action="?/update" use:enhance>
				<StatusPageForm {values} monitors={data.monitors} {errors} origin={page.url.origin} />
				<div class="spe-actions">
					<button type="submit" class="btn btn-primary">Save changes</button>
				</div>
			</form>
		{/key}
	</div>
</div>

<div class="card">
	<div class="card__h"><h3>Delete this page</h3></div>
	<form
		class="spe-body spe-del"
		method="POST"
		action="?/delete"
		use:enhance={({ cancel }) => {
			if (!confirm('Delete this status page? Its address stops working at once.')) cancel();
		}}
	>
		<p>The page's address stops working at once. Your monitors are not touched.</p>
		<button type="submit" class="btn btn-ghost spe-danger">Delete page</button>
	</form>
</div>

<style>
	.spe-msg {
		margin-bottom: 14px;
	}
	.spe-body {
		padding: 16px;
	}
	.spe-actions {
		margin-top: 16px;
	}
	.spe-del {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}
	.spe-del p {
		margin: 0;
		font-size: 13px;
		color: var(--ink-3);
	}
	.spe-danger {
		color: var(--down);
	}
</style>
