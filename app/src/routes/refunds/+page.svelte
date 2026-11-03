<script lang="ts">
	import { resolve } from '$app/paths';
	import LegalPage from '#lib/components/legal/legal-page.svelte';
	import { PLANS } from '#lib/plans.js';
</script>

<LegalPage title="Refund Policy" lastUpdated="2026-11-03">
	<p>
		<strong>Pro is not on sale yet.</strong> Until it is, nobody is charged, so there is nothing to refund.
		This page says how refunds will work once it is.
	</p>

	<h2>Who you are buying from</h2>
	<p>
		<strong>Stripe is the merchant of record and the seller.</strong> When you subscribe to nabz Pro,
		your contract of sale is with Stripe. Stripe takes the payment, is liable for sales tax and VAT, issues
		your invoice, and processes refunds and disputes. No card detail ever reaches nabz or Lytron Systems
		Ltd.
	</p>
	<p>
		Stripe's own terms apply to the transaction. This page says what we will ask Stripe to do, and
		it is never less than what the law gives you. As merchant of record, Stripe may also refund a
		payment itself, without asking us.
	</p>

	<h2>The plan</h2>
	<p>
		Pro costs ${PLANS.pro.priceMonthlyUsd} a month or ${PLANS.pro.priceYearlyUsd} a year, including any
		VAT or sales tax. It raises limits and nothing else; see the
		<a href={resolve('/pricing')}>pricing page</a>. Everything the Free plan does, it keeps doing
		for as long as you like, without paying.
	</p>

	<h2>Getting your money back</h2>
	<p>
		<strong>Within 14 days of any payment, ask and we will refund it in full.</strong> No reason is needed,
		and we will not ask for one. That covers a first subscription and every renewal.
	</p>
	<p>
		Later than that, ask anyway: a renewal you did not want, a period you did not use. We will look
		at it. Beyond 14 days we do not promise a refund, and saying so plainly is better than implying
		one and arguing later.
	</p>
	<p>The money goes back the way it came, to the card or account you paid with.</p>

	<h2>Your statutory rights</h2>
	<p>
		If you are a consumer in the UK or the EU, you have a right to cancel a distance contract within
		14 days. That right can be lost for digital services once supply begins with your consent, which
		is why the 14 days above are written as a promise: they stand whether or not the statutory right
		survived. Nothing here reduces a right you have that cannot be reduced by agreement.
	</p>

	<h2>Cancelling</h2>
	<p>
		Cancel any time, yourself. Cancelling stops the next renewal; it is not a refund of the period
		you are in, and you keep Pro until that period ends.
	</p>

	<h2>What a refund does to your monitors</h2>
	<p>
		<strong>Nothing is deleted, hidden or paused.</strong> An account back on Free keeps every
		monitor, channel and status page it has, and they keep running. A Free limit only ever refuses
		something new. The <a href={resolve('/terms')}>terms</a> say exactly what changes.
	</p>

	<h2>Asking</h2>
	<p>
		Write to <a href="mailto:support@nabz.sh">support@nabz.sh</a>, or reply to the receipt Stripe
		sends you. Either of us can start a refund.
	</p>
</LegalPage>
