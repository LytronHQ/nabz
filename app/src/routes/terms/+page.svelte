<script lang="ts">
	import { resolve } from '$app/paths';
	import LegalPage from '#lib/components/legal/legal-page.svelte';
	import { GRACE_DAYS, PLANS } from '#lib/plans.js';
</script>

<LegalPage title="Terms of Service" lastUpdated="2026-11-03">
	<h2>Acceptance</h2>
	<p>
		By creating an account or using nabz (the "Service") at <a href="https://nabz.sh">nabz.sh</a>,
		you agree to these terms. If you use the Service on behalf of an organisation, you represent
		that you may bind that organisation to these terms.
	</p>

	<h2>The service</h2>
	<p>
		nabz monitors the availability of websites, hosts, and services you configure, and sends alerts
		when they change state. Monitoring is provided on a best-effort basis: while we aim for accurate
		and timely checks across multiple regions, we do not guarantee that every outage will be
		detected or every alert delivered. The Service is not a substitute for your own operational
		safeguards.
	</p>

	<h2>Your responsibilities</h2>
	<ul>
		<li>Provide accurate account information and keep your credentials secure.</li>
		<li>
			Only monitor targets you own or are authorised to monitor. Do not use the Service to probe,
			overload, or attack systems without permission.
		</li>
		<li>
			Do not use the Service to break the law, infringe others' rights, or send unsolicited or
			abusive content through alert channels.
		</li>
		<li>Respect the usage limits of the Service, including on the anonymous trial.</li>
	</ul>

	<h2>Plans</h2>
	<p>
		There are two plans, Free and Pro, and their limits are listed on the
		<a href={resolve('/pricing')}>pricing page</a>: how many monitors an account may have, how often
		they may be checked, which alert channels it may add, and how many status pages it may publish.
		The pricing page is the one source for those numbers, and the Service enforces the same numbers
		it shows.
	</p>
	<p>
		Pro costs ${PLANS.pro.priceMonthlyUsd} a month or ${PLANS.pro.priceYearlyUsd} a year, including any
		VAT or sales tax. It is not on sale yet; until it is, nobody is charged anything, and accounts created
		before plans were introduced are on Pro at no charge.
	</p>

	<h2>Payment</h2>
	<p>
		Once Pro is on sale, <strong>Stripe is the merchant of record and the seller</strong>. When you
		subscribe, your contract of sale is with Stripe: it takes the payment, is liable for sales tax
		and VAT, issues your invoice, and handles refunds, disputes and fraud. Its terms apply to the
		transaction itself.
	</p>
	<p>
		A subscription renews each month or each year until cancelled. You can cancel at any time
		yourself, and you keep Pro until the end of the period you have paid for. Refunds are covered by
		the <a href={resolve('/refunds')}>refund policy</a>.
	</p>

	<h2>What a lapsed plan does</h2>
	<p>
		<strong>Nothing you have is deleted, hidden, paused or locked</strong> because a subscription ended
		or a payment failed. Your monitors keep running, your alert channels keep alerting, your status pages
		stay online, and your history stays readable.
	</p>
	<p>
		What changes is what you can add. An account back on Free that is over a Free limit cannot add
		another monitor, channel type or status page until it is back within that limit. After a grace
		period of {GRACE_DAYS} days, monitors that are checked faster than Free allows are slowed to Free's
		fastest interval, because each check costs money to run; they are not stopped. This is a term of the
		contract, not a policy we may quietly revise.
	</p>

	<h2>Anonymous trials</h2>
	<p>
		You may try one monitor without an account. Trial monitors run in an isolated environment, are
		rate-limited, and are automatically deleted after one hour. Trials are provided as-is for
		evaluation only.
	</p>

	<h2>Availability and changes</h2>
	<p>
		We may modify, suspend, or discontinue parts of the Service, and may change these terms. We will
		make reasonable efforts to communicate material changes. Continued use after a change
		constitutes acceptance.
	</p>

	<h2>Termination</h2>
	<p>
		You may stop using the Service and delete your account at any time. We may suspend or terminate
		accounts that violate these terms or that we reasonably believe pose a risk to the Service or
		others.
	</p>

	<h2>Disclaimer and liability</h2>
	<p>
		The Service is provided "as is" and "as available", without warranties of any kind, whether
		express or implied. To the maximum extent permitted by law, we are not liable for any indirect,
		incidental, or consequential damages, or for losses arising from missed or delayed alerts or
		from reliance on the Service's availability data.
	</p>

	<h2>Contact</h2>
	<p>Questions about these terms: <a href="mailto:support@nabz.sh">support@nabz.sh</a>.</p>
</LegalPage>
