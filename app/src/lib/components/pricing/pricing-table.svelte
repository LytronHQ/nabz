<script lang="ts">
	// The plans side by side (#682), on /pricing and the landing page. Every number
	// comes from plans.ts, so what is advertised is what is enforced.
	import { resolve } from '$app/paths';
	import { PLANS, PRO_ON_SALE, formatHistory, formatInterval, listChannels } from '#lib/plans.js';
	import { AlertChannelTypes } from '#lib/models/alert-channel.js';

	const free = PLANS.free;
	const pro = PLANS.pro;
	const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
	const channels = (p: typeof free) =>
		p.channelTypes.length === AlertChannelTypes.length
			? `Every alert channel: ${listChannels(p.channelTypes)}`
			: `${cap(listChannels(p.channelTypes))} alerts`;
	const pages = (p: typeof free) =>
		`${p.statusPages} status ${p.statusPages === 1 ? 'page' : 'pages'}${p.statusPageFooter ? ', with a "Powered by nabz" footer' : ', no nabz footer'}`;
	const yearlySaving = pro.priceMonthlyUsd * 12 - pro.priceYearlyUsd;
</script>

<div class="pt">
	<section class="pt-plan" aria-labelledby="pt-free">
		<h3 id="pt-free">{free.name}</h3>
		<p class="pt-price"><span class="pt-amount">$0</span> <span class="pt-per">forever</span></p>
		<ul class="pt-list">
			<li>{free.monitors} monitors</li>
			<li>Checks every {formatInterval(free.minIntervalSeconds)}</li>
			<li>{channels(free)}</li>
			<li>{pages(free)}</li>
			<li>{cap(formatHistory(free.historyDays))} of uptime and incident history</li>
		</ul>
		<a class="btn btn-ghost pt-cta" href={resolve('/signup')}>Start free</a>
	</section>

	<section class="pt-plan pt-plan--pro" aria-labelledby="pt-pro">
		<h3 id="pt-pro">{pro.name}</h3>
		<p class="pt-price">
			<span class="pt-amount">${pro.priceMonthlyUsd}</span> <span class="pt-per">a month</span>
		</p>
		<p class="pt-alt">
			or ${pro.priceYearlyUsd} a year{#if yearlySaving > 0}, two months free{/if}. Incl. VAT / tax
			where applicable.
		</p>
		<ul class="pt-list">
			<li>{pro.monitors} monitors</li>
			<li>Checks every {formatInterval(pro.minIntervalSeconds)}</li>
			<li>{channels(pro)}</li>
			<li>{pages(pro)}</li>
			<li>{cap(formatHistory(pro.historyDays))} of uptime and incident history</li>
		</ul>
		{#if PRO_ON_SALE}
			<a class="btn btn-primary pt-cta" href={resolve('/account')}>Get Pro</a>
		{:else}
			<p class="pt-soon">Not on sale yet. Pro opens once billing is ready.</p>
		{/if}
	</section>
</div>

<p class="pt-note">
	A lapsed plan never deletes or pauses anything, and history is kept in full. Limits only refuse
	what you add next.
</p>

<style>
	.pt {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
		gap: 18px;
	}
	.pt-plan {
		border: 1px solid var(--border);
		border-radius: var(--radius-btn);
		background: var(--surface);
		padding: 22px 22px 20px;
		display: flex;
		flex-direction: column;
		gap: 10px;
		min-width: 0;
	}
	.pt-plan--pro {
		border-color: var(--accent);
	}
	.pt-plan h3 {
		margin: 0;
		font-size: 15px;
		font-weight: 600;
		color: var(--ink);
	}
	.pt-price {
		margin: 0;
		display: flex;
		align-items: baseline;
		gap: 6px;
	}
	.pt-amount {
		font-family: var(--font-stat);
		font-size: 34px;
		line-height: 1;
		color: var(--ink);
		font-variant-numeric: tabular-nums;
	}
	.pt-per {
		color: var(--ink-3);
		font-size: 14px;
	}
	.pt-alt {
		margin: 0;
		font-size: 13px;
		color: var(--ink-3);
	}
	.pt-list {
		list-style: none;
		margin: 6px 0 4px;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 8px;
		font-size: 14px;
		color: var(--ink);
	}
	.pt-list li {
		padding-inline-start: 18px;
		position: relative;
	}
	.pt-list li::before {
		content: '';
		position: absolute;
		inset-inline-start: 2px;
		top: 0.55em;
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--up);
	}
	.pt-cta {
		margin-top: auto;
		align-self: flex-start;
	}
	.pt-soon {
		margin: auto 0 0;
		font-size: 13px;
		color: var(--ink-3);
	}
	.pt-note {
		margin: 14px 0 0;
		font-size: 13px;
		color: var(--ink-3);
	}
</style>
