<script lang="ts">
	import { resolve } from '$app/paths';
	// Shared shell for the standalone legal pages (/privacy, /terms). Self-contained
	// and theme-aware (like the changelog page), in the Blueprint aesthetic: petrol
	// brand, hairline rules, no shadows, Inter. The content goes in the default slot.
	import { Meta } from '$lib/components/common';

	interface Props {
		title: string;
		lastUpdated: string; // ISO date, shown in the header
		draft?: boolean; // these are drafts pending review — banner on by default
		children?: import('svelte').Snippet;
	}

	let { title, lastUpdated, draft = true, children }: Props = $props();
</script>

<Meta title={`${title} — nabz`} />

<div class="legal-page">
	<div class="legal">
		<header class="legal-nav">
			<a class="legal-brand" href={resolve('/')}>
				<span class="legal-mark">
					<svg
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2.4"
						stroke-linecap="round"
						stroke-linejoin="round"><path d="M3 12h4l2.5-7 5 14 2.5-7H21" /></svg
					>
				</span>
				<b>nabz</b>
			</a>
			<a class="legal-back" href={resolve('/')}>← Back</a>
		</header>

		{#if draft}
			<p class="legal-draft" role="note">
				<b>DRAFT — pending review.</b> This document has not been reviewed or published. It is not legally
				binding in its current form.
			</p>
		{/if}

		<h1>{title}</h1>
		<p class="legal-updated mono">Last updated: {lastUpdated}</p>

		<div class="legal-body">
			{@render children?.()}
		</div>
	</div>
</div>

<style>
	.legal-page {
		/* Self-contained palette so the page renders correctly outside the app
		   shell; theme-aware via prefers-color-scheme. Petrol brand per the
		   Blueprint design system. */
		--ground: #ffffff;
		--ink: #16211f;
		--ink-2: #4a5754;
		--rule: #dfe4e2;
		--brand: #123b40;
		--brand-ink: #ffffff;
		--wash: #f5f7f6;

		min-height: 100vh;
		background: var(--ground);
		color: var(--ink);
		font-family:
			Inter,
			system-ui,
			-apple-system,
			sans-serif;
		line-height: 1.6;
	}
	@media (prefers-color-scheme: dark) {
		.legal-page {
			--ground: #0e1615;
			--ink: #e7ecea;
			--ink-2: #9aa8a4;
			--rule: #253230;
			--brand: #7fb2b0;
			--brand-ink: #0e1615;
			--wash: #141d1c;
		}
	}

	.legal {
		max-width: 46rem;
		margin: 0 auto;
		padding: 2.5rem 1.25rem 4rem;
	}
	.legal-nav {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding-bottom: 1.5rem;
		border-bottom: 1px solid var(--rule);
		margin-bottom: 2rem;
	}
	.legal-brand {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		color: var(--ink);
		text-decoration: none;
		font-size: 1.05rem;
	}
	.legal-mark {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.75rem;
		height: 1.75rem;
		background: var(--brand);
		color: var(--brand-ink);
		border-radius: 0.4rem;
	}
	.legal-mark svg {
		width: 1.1rem;
		height: 1.1rem;
	}
	.legal-back {
		color: var(--ink-2);
		text-decoration: none;
		font-size: 0.9rem;
	}
	.legal-back:hover {
		color: var(--ink);
	}

	.legal-draft {
		border: 1px dashed var(--rule);
		background: var(--wash);
		color: var(--ink-2);
		padding: 0.75rem 1rem;
		border-radius: 0.4rem;
		font-size: 0.9rem;
		margin-bottom: 1.5rem;
	}
	.legal-draft b {
		color: var(--ink);
	}

	h1 {
		font-size: 1.9rem;
		font-weight: 650;
		letter-spacing: -0.01em;
		margin: 0 0 0.35rem;
	}
	.legal-updated {
		color: var(--ink-2);
		font-size: 0.85rem;
		margin: 0 0 2rem;
	}
	.mono {
		font-family: ui-monospace, 'SF Mono', Menlo, monospace;
	}

	/* Content styling — applies to the slotted markup. */
	.legal-body :global(h2) {
		font-size: 1.2rem;
		font-weight: 620;
		margin: 2.25rem 0 0.75rem;
		padding-top: 1.25rem;
		border-top: 1px solid var(--rule);
	}
	.legal-body :global(h2:first-child) {
		border-top: none;
		padding-top: 0;
		margin-top: 0;
	}
	.legal-body :global(p) {
		margin: 0 0 1rem;
	}
	.legal-body :global(ul) {
		margin: 0 0 1rem;
		padding-left: 1.25rem;
	}
	.legal-body :global(li) {
		margin: 0 0 0.4rem;
	}
	.legal-body :global(a) {
		color: var(--brand);
		text-decoration: underline;
	}
	.legal-body :global(strong) {
		color: var(--ink);
	}
</style>
