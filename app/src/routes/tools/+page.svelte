<script lang="ts">
	import { resolve } from '$app/paths';
	import { Meta } from '#lib/components/common/index.js';
	import PublicHeader from '#lib/components/public/public-header.svelte';
	import { TOOLS } from '#lib/tools/tools.js';
</script>

<Meta title="Free uptime and network check tools" />

<div class="tl-page">
	<div class="tl">
		<PublicHeader />
		<h1>Free check tools</h1>
		<p class="tl-lead">
			One-off checks from probes in several countries, free and without an account. When one of them
			matters, nabz can keep checking it for you and tell you when it breaks.
		</p>
		<ul class="tl-grid">
			{#each TOOLS as t (t.id)}
				<li>
					<a class="tl-card" href={resolve('/tools/[tool]', { tool: t.id })}>
						<span class="tl-name">{t.name}</span>
						<span class="tl-blurb">{t.blurb}</span>
					</a>
				</li>
			{/each}
		</ul>
		<p class="tl-credit">
			Checks run on <a href="https://globalping.io" rel="noopener">Globalping</a>'s network of
			volunteer probes.
		</p>
	</div>
</div>

<style>
	.tl-page {
		min-height: 100vh;
		background: var(--ground);
	}
	.tl {
		max-width: 880px;
		margin: 0 auto;
		padding: 24px 16px 48px;
	}
	h1 {
		margin: 0 0 10px;
		font-size: 34px;
		color: var(--ink);
	}
	.tl-lead {
		margin: 0 0 28px;
		max-width: 62ch;
		color: var(--ink-2);
		font-size: 16px;
	}
	.tl-grid {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
		gap: 14px;
	}
	.tl-card {
		display: flex;
		flex-direction: column;
		gap: 6px;
		height: 100%;
		padding: 18px;
		border: 1px solid var(--border);
		border-radius: var(--radius-btn);
		background: var(--surface);
		text-decoration: none;
	}
	.tl-card:hover,
	.tl-card:focus-visible {
		border-color: var(--accent);
	}
	.tl-name {
		font-weight: 600;
		color: var(--ink);
	}
	.tl-blurb {
		font-size: 14px;
		color: var(--ink-2);
	}
	.tl-credit {
		margin-top: 28px;
		font-size: 13px;
		color: var(--ink-3);
	}
	.tl-credit a {
		color: var(--accent);
		text-decoration: underline;
		text-underline-offset: 2px;
	}
	@media (max-width: 480px) {
		h1 {
			font-size: 28px;
		}
	}
</style>
