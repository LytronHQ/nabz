<script lang="ts">
	import { resolve } from '$app/paths';
	import { Meta } from '$lib/components/common';

	let { data } = $props();
	let entries = $derived(data.entries ?? []);

	const isIsoDate = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d);

	function fmtDate(d: string): string {
		const dt = new Date(d + 'T00:00:00Z');
		return Number.isNaN(dt.getTime())
			? d
			: dt.toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' });
	}
</script>

<Meta title="Changelog — nabz" />

<div class="cl-page theme-dark">
	<div class="cl">
		<header class="cl-nav">
			<a class="cl-brand" href={resolve('/')}>
				<span class="cl-mark">
					<svg
						viewBox="0 0 24 24"
						fill="none"
						stroke="#fff"
						stroke-width="2.4"
						stroke-linecap="round"
						stroke-linejoin="round"><path d="M3 12h4l2.5-7 5 14 2.5-7H21" /></svg
					>
				</span>
				<b>nabz</b>
			</a>
			<a class="cl-back" href={resolve('/')}>← Back</a>
		</header>

		<h1>Changelog</h1>
		<p class="cl-lead">What's new in nabz.</p>

		<ol class="cl-list">
			{#each entries as e, i (i)}
				<li class="cl-entry">
					<div class="cl-head">
						<h2 class="cl-ver">{e.version}</h2>
						{#if e.date}
							{#if isIsoDate(e.date)}
								<time class="cl-date mono" datetime={e.date}>{fmtDate(e.date)}</time>
							{:else}
								<span class="cl-date mono cl-status">{e.date}</span>
							{/if}
						{/if}
					</div>
					<!-- e.html is built server-side from escaped changelog text -->
					<div class="cl-body">{@html e.html}</div>
				</li>
			{/each}
		</ol>
	</div>
</div>

<style>
	.cl-page {
		min-height: 100vh;
		background: var(--ground);
		color: var(--ink);
	}
	.cl {
		max-width: 760px;
		margin: 0 auto;
		padding: 0 24px 80px;
	}
	.cl-nav {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 20px 0 36px;
	}
	.cl-brand {
		display: inline-flex;
		align-items: center;
		gap: 10px;
		text-decoration: none;
		color: var(--ink);
		font-size: 16px;
	}
	.cl-mark {
		display: grid;
		place-items: center;
		width: 28px;
		height: 28px;
		border-radius: var(--radius-btn);
		background: var(--accent);
	}
	.cl-mark svg {
		width: 17px;
		height: 17px;
	}
	.cl-back {
		color: var(--ink-2);
		text-decoration: none;
		font-size: 14px;
	}
	.cl-back:hover {
		color: var(--ink);
	}
	.cl h1 {
		font-size: clamp(26px, 4vw, 32px);
		letter-spacing: -0.02em;
		margin: 0 0 8px;
	}
	.cl-lead {
		color: var(--ink-2);
		font-size: 15px;
		margin: 0 0 40px;
	}
	.cl-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 32px;
	}
	.cl-entry {
		padding-top: 24px;
		border-top: 1px solid var(--border);
	}
	.cl-entry:first-child {
		border-top: 0;
		padding-top: 0;
	}
	.cl-head {
		margin-bottom: 14px;
	}
	.cl-ver {
		margin: 0;
		font-size: 17px;
		font-weight: 640;
		letter-spacing: -0.01em;
		color: var(--ink);
	}
	.cl-date {
		display: block;
		margin-top: 3px;
		font-size: 12px;
		color: var(--ink-3);
	}
	.cl-status {
		text-transform: uppercase;
		letter-spacing: 0.08em;
		font-size: 10.5px;
		font-style: italic;
	}
	.mono {
		font-family: inherit;
	}
	.cl-body :global(ul) {
		margin: 0;
		padding: 0;
		list-style: none;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.cl-body :global(li) {
		position: relative;
		padding-left: 18px;
		font-size: 14.5px;
		line-height: 1.55;
		color: var(--ink);
	}
	.cl-body :global(li)::before {
		content: '';
		position: absolute;
		left: 2px;
		top: 9px;
		width: 5px;
		height: 5px;
		border-radius: 50%;
		background: var(--accent);
	}
	.cl-body :global(a) {
		color: var(--accent-strong);
		text-decoration: none;
	}
	.cl-body :global(a):hover {
		text-decoration: underline;
	}
	.cl-body :global(code) {
		font-family: inherit;
		font-size: 0.9em;
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: var(--radius-btn);
		padding: 0 5px;
	}
</style>
