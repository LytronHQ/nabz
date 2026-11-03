<script lang="ts">
	import { resolve } from '$app/paths';
	import { Meta } from '#lib/components/common/index.js';
	import PublicHeader from '#lib/components/public/public-header.svelte';
	import PricingTable from '#lib/components/pricing/pricing-table.svelte';
</script>

<Meta title="Pricing" />

<div class="pr-page">
	<div class="pr">
		<PublicHeader />

		<h1>Pricing</h1>
		<p class="pr-lead">
			Start free and stay free as long as it fits. The code is open source too, so you can also run
			nabz on your own servers at no cost.
		</p>

		<PricingTable />

		<h2>Questions</h2>
		<dl class="pr-faq">
			<dt>What happens if I stop paying?</dt>
			<dd>
				Nothing you have is deleted, hidden or paused. Your monitors keep running. After a short
				grace period, checks that run faster than the Free plan allows slow to its fastest interval,
				and new monitors or channels are refused until you are back within the Free limits.
			</dd>
			<dt>Who takes the payment?</dt>
			<dd>
				Stripe, as merchant of record, once Pro is on sale. Stripe charges the price shown, handles
				the tax and sends the invoice. See the <a href={resolve('/terms')}>terms</a> and the
				<a href={resolve('/refunds')}>refund policy</a>.
			</dd>
			<dt>Can I cancel any time?</dt>
			<dd>Yes. You keep Pro until the end of the period you paid for.</dd>
		</dl>

		<footer class="pr-foot">
			<a href={resolve('/terms')}>Terms</a>
			<a href={resolve('/privacy')}>Privacy</a>
			<a href={resolve('/refunds')}>Refunds</a>
		</footer>
	</div>
</div>

<style>
	.pr-page {
		min-height: 100vh;
		background: var(--ground);
	}
	.pr {
		max-width: 880px;
		margin: 0 auto;
		padding: 24px 16px 48px;
	}
	h1 {
		margin: 0 0 10px;
		font-size: 34px;
		color: var(--ink);
	}
	.pr-lead {
		margin: 0 0 28px;
		max-width: 60ch;
		color: var(--ink-2);
		font-size: 16px;
	}
	h2 {
		margin: 44px 0 12px;
		font-size: 20px;
		color: var(--ink);
	}
	.pr-faq {
		margin: 0;
	}
	.pr-faq dt {
		font-weight: 600;
		color: var(--ink);
		margin-top: 18px;
	}
	.pr-faq dd {
		margin: 6px 0 0;
		color: var(--ink-2);
		max-width: 66ch;
		line-height: 1.6;
	}
	.pr-faq a,
	.pr-foot a {
		color: var(--accent);
		text-decoration: underline;
		text-underline-offset: 2px;
	}
	.pr-foot {
		display: flex;
		gap: 18px;
		margin-top: 48px;
		padding-top: 18px;
		border-top: 1px solid var(--border);
		font-size: 13px;
	}
	@media (max-width: 480px) {
		h1 {
			font-size: 28px;
		}
	}
</style>
