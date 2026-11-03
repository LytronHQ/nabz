<script lang="ts">
	import { resolve } from '$app/paths';
	import { Meta } from '#lib/components/common/index.js';
	import PublicHeader from '#lib/components/public/public-header.svelte';
	import { CHECKED_ON, COMPETITORS } from '#lib/compare.js';
	import { PLANS, PRO_ON_SALE } from '#lib/plans.js';

	let { data } = $props();
	let c = $derived(data.competitor);
	let others = $derived(COMPETITORS.filter((o) => o.slug !== c.slug));

	// 300 -> "5-minute", 30 -> "30-second".
	const every = (s: number) => (s % 60 === 0 ? `${s / 60}-minute` : `${s}-second`);
	const free = PLANS.free;
	const pro = PLANS.pro;
	const checked = new Date(CHECKED_ON).toLocaleDateString('en-GB', {
		day: 'numeric',
		month: 'long',
		year: 'numeric'
	});
	const nabzPlans = [
		{
			name: 'Free',
			price: '$0',
			facts: [
				`${free.monitors} monitors`,
				`${every(free.minIntervalSeconds)} checks`,
				`${free.statusPages} status page`,
				'Email, push and webhook alerts'
			]
		},
		{
			name: 'Pro',
			price: `$${pro.priceMonthlyUsd} a month ($${pro.priceYearlyUsd} a year)${PRO_ON_SALE ? '' : ', not on sale yet'}`,
			facts: [
				`${pro.monitors} monitors`,
				`${every(pro.minIntervalSeconds)} checks`,
				`${pro.statusPages} status pages`,
				'Every alert channel'
			]
		},
		{
			name: 'Self-hosted',
			price: '$0, on your own servers',
			facts: ['As many monitors as your servers can run', 'Every feature', 'AGPL-3.0 licence']
		}
	];
</script>

<Meta title={`nabz vs ${c.name}`} />

<div class="cp-page">
	<div class="cp">
		<PublicHeader />
		<h1>nabz vs {c.name}</h1>
		<p class="cp-lead">
			nabz is open source under the AGPL. Run it on your own servers for free, or use the hosted
			version: Free, or Pro at ${pro.priceMonthlyUsd} a month. Here is how the plans line up, and where
			{c.name} is ahead.
		</p>

		<div class="cp-cols">
			<section class="cp-col" aria-labelledby="cp-nabz">
				<h2 id="cp-nabz">nabz</h2>
				{#each nabzPlans as p (p.name)}
					<div class="cp-plan">
						<h3>{p.name}</h3>
						<p class="cp-price">{p.price}</p>
						<ul>
							{#each p.facts as f (f)}<li>{f}</li>{/each}
						</ul>
					</div>
				{/each}
			</section>
			<section class="cp-col" aria-labelledby="cp-them">
				<h2 id="cp-them">{c.name}</h2>
				{#each c.plans as p (p.name)}
					<div class="cp-plan">
						<h3>{p.name}</h3>
						<p class="cp-price">{p.price}</p>
						<ul>
							{#each p.facts as f (f)}<li>{f}</li>{/each}
						</ul>
					</div>
				{/each}
			</section>
		</div>
		<p class="cp-source">
			<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- an external competitor URL from compare.ts -->
			{c.name}'s figures are from <a href={c.pricingUrl} rel="noopener">its pricing page</a>, read
			on
			{checked}. Prices change; check theirs before you decide.
		</p>

		<h2>Where {c.name} is ahead</h2>
		<ul class="cp-list">
			{#each c.ahead as a (a)}<li>{a}</li>{/each}
		</ul>

		<h2>Where nabz is different</h2>
		<ul class="cp-list">
			<li>
				The code is open source (AGPL-3.0). You can read it, run it yourself at no cost, and change
				it.
			</li>
			<li>
				The hosted Pro plan is ${pro.priceMonthlyUsd} a month for {pro.monitors} monitors checked every
				{pro.minIntervalSeconds} seconds.
			</li>
			<li>
				When a check fails because of nabz's own network, the check is marked "not counted" and does
				not lower your uptime.
			</li>
		</ul>

		<h2>What both do</h2>
		<p class="cp-text">
			Both confirm an outage before alerting. nabz waits until its zones agree that a service is
			<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- an external competitor URL from compare.ts -->
			down. {c.name}: "<a href={c.confirmation.url} rel="noopener">{c.confirmation.text}</a>"
		</p>

		<div class="cp-cta">
			<a class="btn btn-primary" href={resolve('/signup')}>Start free</a>
			<a class="btn btn-ghost" href="https://github.com/LytronHQ/nabz" rel="noopener"
				>Self-host it</a
			>
			<a class="cp-more" href={resolve('/pricing')}>See pricing</a>
		</div>

		{#if others.length}
			<p class="cp-others">
				Also: {#each others as o, i (o.slug)}<a href={resolve('/compare/[slug]', { slug: o.slug })}
						>nabz vs {o.name}</a
					>{i < others.length - 1 ? ', ' : ''}{/each}
			</p>
		{/if}
	</div>
</div>

<style>
	.cp-page {
		min-height: 100vh;
		background: var(--ground);
	}
	.cp {
		max-width: 880px;
		margin: 0 auto;
		padding: 24px 16px 48px;
	}
	h1 {
		margin: 0 0 10px;
		font-size: 34px;
		color: var(--ink);
	}
	.cp-lead {
		margin: 0 0 28px;
		max-width: 64ch;
		color: var(--ink-2);
		font-size: 16px;
		line-height: 1.6;
	}
	.cp-cols {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
		gap: 18px;
	}
	.cp-col {
		border: 1px solid var(--border);
		border-radius: var(--radius-btn);
		background: var(--surface);
		padding: 18px 20px 6px;
		min-width: 0;
	}
	.cp-col h2 {
		margin: 0 0 10px;
		font-size: 18px;
	}
	.cp-plan {
		padding: 12px 0;
		border-top: 1px solid var(--border);
	}
	.cp-plan h3 {
		margin: 0;
		font-size: 14px;
		font-weight: 600;
		color: var(--ink);
	}
	.cp-price {
		margin: 2px 0 6px;
		font-size: 14px;
		color: var(--ink-2);
	}
	.cp-plan ul,
	.cp-list {
		margin: 0;
		padding-inline-start: 18px;
		color: var(--ink);
		font-size: 14px;
		line-height: 1.6;
	}
	.cp-list {
		max-width: 66ch;
		font-size: 15px;
	}
	/* The app's base styles drop list markers; without them each item read like
	   one run-on paragraph (visual check, #683). */
	.cp-plan ul,
	.cp-list {
		list-style: disc;
	}
	.cp-plan li + li,
	.cp-list li + li {
		margin-top: 4px;
	}
	.cp-list li + li {
		margin-top: 8px;
	}
	.cp-source {
		margin: 12px 0 0;
		font-size: 12.5px;
		color: var(--ink-3);
	}
	h2 {
		margin: 36px 0 10px;
		font-size: 20px;
		color: var(--ink);
	}
	.cp-text {
		margin: 0;
		max-width: 66ch;
		color: var(--ink);
		font-size: 15px;
		line-height: 1.6;
	}
	.cp-source a,
	.cp-text a,
	.cp-others a,
	.cp-more {
		color: var(--accent);
		text-decoration: underline;
		text-underline-offset: 2px;
	}
	.cp-cta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 12px;
		margin-top: 32px;
	}
	.cp-others {
		margin-top: 28px;
		font-size: 14px;
		color: var(--ink-2);
	}
	@media (max-width: 480px) {
		h1 {
			font-size: 28px;
		}
	}
</style>
