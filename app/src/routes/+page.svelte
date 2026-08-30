<script lang="ts">
	import { resolve } from '$app/paths';

	import { goto } from '$app/navigation';
	import { Meta, Pill } from '$lib/components/common';

	let { data } = $props();
	const year = new Date().getFullYear();

	// First-touch "try it" (#271): create one monitor without signing up, then land
	// on its (gated) detail page. The anon endpoint sets the session cookie + limits.
	let tryUrl = $state('');
	let busy = $state(false);
	let tryError = $state('');
	async function tryIt() {
		tryError = '';
		if (!tryUrl.trim()) return;
		busy = true;
		try {
			const res = await fetch('/api/anon/monitors', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ target: tryUrl.trim() })
			});
			const body = await res.json().catch(() => ({}));
			if (res.ok && body.id) {
				await goto(resolve('/try/[id]', { id: body.id }));
			} else {
				tryError = body.error || 'Could not start the trial. Please try again.';
			}
		} catch {
			tryError = 'Could not start the trial. Check your connection and try again.';
		} finally {
			busy = false;
		}
	}
</script>

<Meta title="nabz — uptime monitoring for the services you run" />

<!-- theme-dark pins the marketing landing to the dark palette regardless of the
     visitor's saved app theme (the app itself still follows the theme toggle). -->
<div class="lp-page theme-dark">
	<div class="lp">
		<!-- top bar -->
		<header class="lp-nav">
			<a class="lp-brand" href={resolve('/')} aria-label="nabz home">
				<span class="lp-mark">
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
			<nav class="lp-nav-links">
				<a href="#how">How it works</a>
				<a href={resolve('/signin')}>Sign in</a>
				<a class="btn btn-primary" href={resolve('/signup')}>Get started</a>
			</nav>
		</header>

		<!-- hero -->
		<section class="lp-hero">
			<div class="lp-hero-copy">
				<span class="eyebrow">The pulse of your infrastructure</span>
				<h1>Watch your services. Get told when they break.</h1>
				<p class="lead">
					nabz watches your websites, APIs, servers, DNS, and scheduled jobs — checking from more
					than one region, agreeing across zones before it calls anything down, and paging you on
					Slack, Telegram, email, and more the moment it happens. Built for people who run their own
					things.
				</p>
				<form
					class="lp-try"
					onsubmit={(e) => {
						e.preventDefault();
						tryIt();
					}}
				>
					<input
						class="lp-try-input"
						type="url"
						inputmode="url"
						placeholder="https://your-site.com"
						aria-label="URL to monitor"
						bind:value={tryUrl}
						required
					/>
					<button class="btn btn-primary btn-lg" type="submit" disabled={busy}>
						{busy ? 'Starting…' : 'Try it free'}
					</button>
				</form>
				{#if tryError}<p class="lp-try-err" role="alert">{tryError}</p>{/if}
				<p class="lp-beta">
					<span class="dot"></span>No signup — watch it work, then
					<a href={resolve('/signup')}>create an account</a> to keep it. Free during beta.
				</p>
			</div>

			<!-- illustrative status panel (generic example data, not a screenshot) -->
			<div class="lp-panel card" aria-hidden="true">
				<div class="lp-panel-head">
					<span class="mono">monitors</span>
					<span class="mono lp-muted">checked from eu · us</span>
				</div>
				<div class="lp-row">
					<span class="lp-host">example.com</span>
					<Pill tone="up" label="Up" />
					<span class="lp-ms">142 ms</span>
				</div>
				<div class="lp-row">
					<span class="lp-host">api.example.com</span>
					<Pill tone="up" label="Up" />
					<span class="lp-ms">88 ms</span>
				</div>
				<div class="lp-row">
					<span class="lp-host">staging.example.io</span>
					<Pill tone="down" label="Down" />
					<span class="lp-ms lp-muted">—</span>
				</div>
				<div class="lp-panel-foot mono lp-muted">DNS 12 · connect 20 · TLS 35 · transfer 75 ms</div>
			</div>
		</section>

		<!-- what you can monitor (implemented) -->
		<section class="lp-section">
			<span class="eyebrow">What you can monitor</span>
			<h2>More than a naïve ping.</h2>
			<p class="lp-section-lead">
				Point nabz at whatever you run — a URL, a host and port, a DNS name, or a scheduled job —
				and it watches the details that matter, not just up or down.
			</p>
			<div class="lp-grid">
				<div class="lp-feature">
					<h3>Websites &amp; APIs</h3>
					<p>
						HTTP/HTTPS checks with a full <b>DNS → connect → TLS → first-byte</b> timing breakdown,
						status codes, response-body keyword checks, and a heads-up before either a
						<b>TLS certificate</b>
						or the <b>domain registration</b> expires.
					</p>
				</div>
				<div class="lp-feature">
					<h3>Servers &amp; ports</h3>
					<p>
						Is a <b>TCP port</b> open, and how fast does it connect? Plus ping-style reachability for
						the hosts behind your services.
					</p>
				</div>
				<div class="lp-feature">
					<h3>DNS</h3>
					<p>
						Check that a name resolves to the answer you expect — <b
							>A / AAAA / CNAME / MX / TXT / NS</b
						> — from the system resolver or one you name.
					</p>
				</div>
				<div class="lp-feature">
					<h3>Cron &amp; heartbeats</h3>
					<p>
						Scheduled jobs check in to a private URL each run. If one goes quiet past its window,
						you hear about it.
					</p>
				</div>
			</div>
		</section>

		<!-- why it's reliable -->
		<section class="lp-section lp-reliable">
			<span class="eyebrow">Why it's reliable</span>
			<h2>No false alarms. No silent failures.</h2>
			<div class="lp-two">
				<div class="lp-feature">
					<h3>Multi-zone consensus</h3>
					<p>
						A single checker on a bad network path will see failures that aren't real. nabz checks
						from several zones and only calls a monitor <b>down</b> when the zones <b>agree</b>. One
						flaky path doesn't wake you up.
					</p>
				</div>
				<div class="lp-feature">
					<h3>Independent alerting + dead-man's switch</h3>
					<p>
						Alerting doesn't hang off a single checker. And if an entire checking zone goes
						<b>silent</b>, nabz notices the missing heartbeat and tells you — so you're never left
						wondering whether it's your service that's down or the monitor itself.
					</p>
				</div>
			</div>
		</section>

		<!-- alerting -->
		<section class="lp-section">
			<span class="eyebrow">Alerting</span>
			<h2>Told the right way, to the right people.</h2>
			<div class="lp-grid">
				<div class="lp-feature">
					<h3>Where you already are</h3>
					<p>
						Email, webhook, <b>Slack</b>, <b>Telegram</b>, <b>Discord</b>, and <b>PagerDuty</b> — and
						you can send a test to any of them with a click.
					</p>
				</div>
				<div class="lp-feature">
					<h3>Escalation policies</h3>
					<p>
						Page one channel first, then more if nobody acknowledges — so a missed alert doesn't
						become a missed outage.
					</p>
				</div>
				<div class="lp-feature">
					<h3>Maintenance windows</h3>
					<p>
						Planned work shouldn't wake anyone. Schedule a window and checks keep running while
						alerts stay quiet.
					</p>
				</div>
				<div class="lp-feature">
					<h3>Slow-response alerts</h3>
					<p>
						Get warned when p95 latency creeps past a threshold you set — before slow turns into
						down.
					</p>
				</div>
			</div>
		</section>

		<!-- how it works -->
		<section class="lp-section" id="how">
			<span class="eyebrow">How it works</span>
			<h2>Four steps, then it's out of your way.</h2>
			<ol class="lp-steps">
				<li>
					<span class="lp-step-n mono">01</span>
					<div>
						<h3>Add a monitor</h3>
						<p>
							A URL, a host and port, a DNS name, or a cron check-in — plus an interval. That's the
							setup.
						</p>
					</div>
				</li>
				<li>
					<span class="lp-step-n mono">02</span>
					<div>
						<h3>Checked from multiple zones</h3>
						<p>nabz probes the endpoint on your interval, from more than one region at once.</p>
					</div>
				</li>
				<li>
					<span class="lp-step-n mono">03</span>
					<div>
						<h3>Consensus decides up or down</h3>
						<p>
							The zones' results are combined — agreement, not a single reading, sets the status.
						</p>
					</div>
				</li>
				<li>
					<span class="lp-step-n mono">04</span>
					<div>
						<h3>You get alerted</h3>
						<p>
							On an incident nabz pages your channels — Slack, Telegram, email, and more. When it
							recovers, you get the all-clear.
						</p>
					</div>
				</li>
			</ol>
		</section>

		<!-- coming soon -->
		<section class="lp-section">
			<span class="eyebrow">On the roadmap</span>
			<h2>Coming soon</h2>
			<p class="lp-section-lead">Not built yet — listed honestly so you know where it's headed.</p>
			<div class="lp-grid lp-soon">
				<div class="lp-feature">
					<span class="lp-tag mono">soon</span>
					<h3>Public status pages</h3>
					<p>Shareable uptime &amp; incident history for a chosen set of monitors.</p>
				</div>
				<div class="lp-feature">
					<span class="lp-tag mono">soon</span>
					<h3>Public API &amp; tokens</h3>
					<p>
						Manage monitors and pull status programmatically — for the people who automate
						everything.
					</p>
				</div>
				<div class="lp-feature">
					<span class="lp-tag mono">soon</span>
					<h3>Mail server checks</h3>
					<p>SMTP / POP3 / IMAP reachability for the people running their own mail.</p>
				</div>
			</div>
		</section>

		<!-- final cta -->
		<section class="lp-final">
			<h2>Start watching your services.</h2>
			<div class="lp-cta">
				<a class="btn btn-primary btn-lg" href={resolve('/signup')}>Get started</a>
				<a class="btn btn-ghost btn-lg" href={resolve('/signin')}>Sign in</a>
			</div>
			<p class="lp-beta"><span class="dot"></span>Free during beta.</p>
		</section>

		<footer class="lp-footer">
			<div class="lp-brand">
				<span class="lp-mark lp-mark-sm">
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
			</div>
			<span class="lp-muted">© {year} nabz · Free during beta</span>
			<div class="lp-footer-links">
				{#if data?.changelogVisible}<a href={resolve('/changelog')}>Changelog</a>{/if}
				<a href={resolve('/signin')}>Sign in</a>
			</div>
		</footer>
	</div>
</div>

<style>
	/* Full-bleed, theme-aware background — the landing renders in the bare body
	   (no app-shell), whose inline no-flash background is a fixed light colour;
	   this paints --ground over it so the page matches the active theme. */
	.lp-page {
		min-height: 100vh;
		background: var(--ground);
	}
	.lp {
		max-width: 1120px;
		margin: 0 auto;
		padding: 0 24px 80px;
		color: var(--ink);
	}
	.eyebrow {
		display: inline-block;
		font-family: inherit;
		text-transform: uppercase;
		letter-spacing: 0.14em;
		font-size: 11px;
		color: var(--accent-strong);
		margin-bottom: 14px;
	}
	.mono {
		font-family: inherit;
	}
	.lp-muted {
		color: var(--ink-3);
	}

	/* top bar */
	.lp-nav {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 20px 0;
		gap: 16px;
	}
	.lp-brand {
		display: inline-flex;
		align-items: center;
		gap: 10px;
		text-decoration: none;
		color: var(--ink);
		font-size: 16px;
	}
	.lp-mark {
		display: grid;
		place-items: center;
		width: 30px;
		height: 30px;
		border-radius: var(--radius-btn);
		background: var(--accent);
	}
	.lp-mark svg {
		width: 18px;
		height: 18px;
	}
	.lp-mark-sm {
		width: 24px;
		height: 24px;
		border-radius: var(--radius-btn);
	}
	.lp-mark-sm svg {
		width: 15px;
		height: 15px;
	}
	.lp-nav-links {
		display: flex;
		align-items: center;
		gap: 22px;
	}
	.lp-nav-links a:not(.btn) {
		color: var(--ink-2);
		text-decoration: none;
		font-size: 14px;
	}
	.lp-nav-links a:not(.btn):hover {
		color: var(--ink);
	}

	/* larger buttons for the landing */
	.btn-lg {
		padding: 11px 20px;
		font-size: 15px;
	}

	/* hero */
	.lp-hero {
		display: grid;
		grid-template-columns: 1.1fr 0.9fr;
		gap: 48px;
		align-items: center;
		padding: 56px 0 72px;
	}
	.lp-hero h1 {
		font-size: clamp(32px, 5vw, 46px);
		line-height: 1.08;
		letter-spacing: -0.02em;
		text-wrap: balance;
		margin: 0 0 18px;
	}
	.lead {
		font-size: 17px;
		line-height: 1.6;
		color: var(--ink-2);
		max-width: 48ch;
		margin: 0 0 28px;
	}
	.lp-cta {
		display: flex;
		flex-wrap: wrap;
		gap: 12px;
	}
	.lp-try {
		display: flex;
		gap: 10px;
		flex-wrap: wrap;
	}
	.lp-try-input {
		flex: 1 1 260px;
		min-width: 0;
		padding: 12px 14px;
		border-radius: var(--radius-btn);
		border: 1px solid var(--border);
		background: var(--surface);
		color: var(--ink);
		font-size: 15px;
	}
	.lp-try-input::placeholder {
		color: var(--ink-3);
	}
	.lp-try-input:focus {
		outline: none;
		border-color: var(--accent);
	}
	.lp-try-err {
		margin: 10px 0 0;
		font-size: 13.5px;
		color: var(--down, #f0653f);
	}
	.lp-beta {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-top: 16px;
		font-size: 13.5px;
		color: var(--ink-3);
	}
	.lp-beta .dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--up);
		box-shadow: 0 0 0 3px var(--up-wash);
	}

	/* illustrative panel */
	.lp-panel {
		padding: 16px;
	}
	.lp-panel-head {
		display: flex;
		justify-content: space-between;
		font-size: 12px;
		color: var(--ink-2);
		padding-bottom: 12px;
		margin-bottom: 6px;
		border-bottom: 1px solid var(--border);
	}
	.lp-row {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 10px 0;
	}
	.lp-host {
		font-family: inherit;
		font-size: 13px;
		color: var(--ink);
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.lp-ms {
		font-family: inherit;
		font-size: 12.5px;
		color: var(--ink-2);
		width: 62px;
		text-align: right;
	}
	.lp-panel-foot {
		font-size: 11.5px;
		padding-top: 12px;
		margin-top: 6px;
		border-top: 1px solid var(--border);
	}

	/* sections */
	.lp-section {
		padding: 56px 0;
		border-top: 1px solid var(--border);
	}
	.lp-section h2,
	.lp-final h2,
	.lp-reliable h2 {
		font-size: clamp(24px, 3.5vw, 30px);
		letter-spacing: -0.02em;
		text-wrap: balance;
		margin: 0 0 12px;
	}
	.lp-section-lead {
		font-size: 15.5px;
		color: var(--ink-2);
		max-width: 60ch;
		margin: 0 0 32px;
		line-height: 1.55;
	}
	.lp-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
		gap: 18px;
	}
	.lp-two {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
		gap: 18px;
		margin-top: 28px;
	}
	.lp-feature {
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 20px;
	}
	.lp-feature h3 {
		font-size: 15.5px;
		margin: 0 0 8px;
		letter-spacing: -0.01em;
	}
	.lp-feature p {
		font-size: 14px;
		line-height: 1.55;
		color: var(--ink-2);
		margin: 0;
	}

	/* steps */
	.lp-steps {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
		gap: 20px;
	}
	.lp-steps li {
		display: flex;
		gap: 14px;
		align-items: flex-start;
	}
	.lp-step-n {
		font-size: 13px;
		color: var(--accent-strong);
		background: var(--accent-wash);
		border-radius: var(--radius-pill);
		padding: 4px 8px;
		flex: 0 0 auto;
	}
	.lp-steps h3 {
		font-size: 15px;
		margin: 2px 0 6px;
	}
	.lp-steps p {
		font-size: 14px;
		color: var(--ink-2);
		margin: 0;
		line-height: 1.5;
	}

	/* coming soon */
	.lp-soon .lp-feature {
		background: var(--surface-2);
		border-style: dashed;
	}
	.lp-tag {
		display: inline-block;
		text-transform: uppercase;
		letter-spacing: 0.1em;
		font-size: 10px;
		color: var(--pending);
		background: var(--pending-wash);
		border-radius: var(--radius-pill);
		padding: 2px 7px;
		margin-bottom: 10px;
	}

	/* final cta */
	.lp-final {
		text-align: center;
		padding: 72px 0 24px;
		border-top: 1px solid var(--border);
	}
	.lp-final .lp-cta {
		justify-content: center;
	}
	.lp-final .lp-beta {
		justify-content: center;
	}

	/* footer */
	.lp-footer {
		display: flex;
		align-items: center;
		gap: 16px;
		flex-wrap: wrap;
		padding: 28px 0 0;
		margin-top: 24px;
		border-top: 1px solid var(--border);
		font-size: 13px;
	}
	.lp-footer .lp-muted {
		margin-left: auto;
	}
	.lp-footer a {
		color: var(--ink-2);
		text-decoration: none;
	}
	.lp-footer a:hover {
		color: var(--ink);
	}
	.lp-footer-links {
		display: inline-flex;
		align-items: center;
		gap: 18px;
	}

	@media (max-width: 760px) {
		.lp-hero {
			grid-template-columns: 1fr;
			gap: 32px;
			padding: 32px 0 48px;
		}
		.lp-nav-links a[href='#how'] {
			display: none;
		}
		.lp-footer .lp-muted {
			margin-left: 0;
		}
	}
	@media (max-width: 560px) {
		/* Clean centered stack instead of a cramped wrap: brand → links →
		   copyright as the bottom fine print. */
		.lp-footer {
			flex-direction: column;
			align-items: center;
			text-align: center;
			gap: 14px;
			padding-top: 24px;
		}
		.lp-footer .lp-muted {
			order: 3;
			color: var(--ink-3);
		}
	}
	@media (max-width: 480px) {
		.lp {
			padding: 0 16px 52px;
		}
		.lp-section {
			padding: 40px 0;
		}
	}
</style>
