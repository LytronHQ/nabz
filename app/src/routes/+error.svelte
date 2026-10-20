<script lang="ts">
	// Without this file SvelteKit's bare fallback answered every error: "404 / Not
	// Found" in the top-left corner when signed out, plain text with no way back
	// inside the app. Signed in, the root layout still wraps this in the app shell.
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { AuthCard, EmptyState, Meta, PageHeader } from '#lib/components/common/index.js';

	const notFound = $derived(page.status === 404);
	const title = $derived(notFound ? 'Page not found' : 'Something went wrong');
	// SvelteKit's generic "Not Found" adds nothing to the title; a specific
	// message from a loader ("Monitor not found") does.
	const detail = $derived(
		page.error?.message && !/^(not found|internal error)$/i.test(page.error.message)
			? page.error.message
			: notFound
				? 'The address may be mistyped, or what was here has been removed.'
				: 'An unexpected error happened. Try again in a moment.'
	);
</script>

<Meta title="{title} — nabz" />

{#if page.data.user}
	<PageHeader {title} sub={`Error ${page.status}`} />
	<EmptyState message={detail}>
		{#snippet action()}
			<a class="btn btn-primary" href={resolve('dashboard')}>Back to the dashboard</a>
		{/snippet}
	</EmptyState>
{:else}
	<AuthCard {title} sub={`Error ${page.status}`}>
		<p class="err-detail">{detail}</p>
		<a class="btn btn-primary btn-block" href={resolve('/')}>Go to the home page</a>
	</AuthCard>
{/if}

<style>
	.err-detail {
		font-size: 13.5px;
		color: var(--ink-2);
		margin-bottom: 18px;
	}
</style>
