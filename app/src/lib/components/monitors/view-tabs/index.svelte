<script lang="ts">
	// Secondary nav for the Monitors section (#223): the three views of the same
	// monitors — List, Map, Dependencies. Rendered at the top of each view page so
	// they read as peers with a single home, instead of a nav item + a button.
	import { page } from '$app/stores';
	import { resolve } from '$app/paths';

	const tabs = [
		{ href: resolve('/monitors'), label: 'List', match: (p: string) => p === '/monitors' },
		{ href: resolve('/monitors/map'), label: 'Map', match: (p: string) => p === '/monitors/map' },
		{
			href: resolve('/monitors/dependencies'),
			label: 'Dependencies',
			match: (p: string) => p.startsWith('/monitors/dependencies')
		}
	];

	let path = $derived($page.url.pathname);
</script>

<nav class="view-tabs" aria-label="Monitor views">
	{#each tabs as t (t.href)}
		<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- the tabs array resolve()s each href where it is declared -->
		<a href={t.href} class:active={t.match(path)} aria-current={t.match(path) ? 'page' : undefined}>
			{t.label}
		</a>
	{/each}
</nav>

<style>
	.view-tabs {
		display: inline-flex;
		gap: 2px;
		padding: 3px;
		margin-bottom: 16px;
		border: 1px solid var(--border);
		border-radius: var(--radius-btn);
		background: var(--surface-1);
	}
	.view-tabs a {
		padding: 6px 14px;
		border-radius: calc(var(--radius-btn) - 3px);
		font-size: 13px;
		font-weight: 500;
		color: var(--text-secondary);
		text-decoration: none;
		white-space: nowrap;
	}
	.view-tabs a:hover {
		color: var(--text-primary);
	}
	.view-tabs a.active {
		background: var(--brand);
		color: #fff;
	}
</style>
