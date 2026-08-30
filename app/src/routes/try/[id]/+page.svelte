<script lang="ts" module>
	import { resolve } from '$app/paths';
	// Compact relative time for "last checked".
	function timeAgo(ts: string, now: number): string {
		const t = new Date(String(ts).replace(' ', 'T')).getTime();
		const s = Math.max(0, Math.floor((now - t) / 1000));
		if (s < 60) return `${s}s ago`;
		const m = Math.floor(s / 60);
		if (m < 60) return `${m}m ago`;
		return `${Math.floor(m / 60)}h ago`;
	}
</script>

<script lang="ts">
	import { onMount } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { Meta, Pill } from '$lib/components/common';
	import type { PillTone } from '$lib/components/common/pill';
	import { usePoll } from '$lib/utils/use-poll';

	let { data } = $props();

	// Live clock for the countdown; the pipeline is async so also poll the row so
	// pending → up/down updates itself without a manual refresh.
	let now = $state(Date.now());
	onMount(() => {
		const t = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(t);
	});
	usePoll(invalidateAll, 8000);

	const TONE: Record<string, PillTone> = {
		up: 'up',
		down: 'down',
		pending: 'pending',
		paused: 'paused'
	};

	function fmtRemaining(ms: number): string {
		const s = Math.floor(ms / 1000);
		const m = Math.floor(s / 60);
		if (m >= 1) return `${m} min`;
		return `${s}s`;
	}

	const locked = [
		{ title: 'Response-time chart', hint: 'DNS · connect · TLS · transfer, per check' },
		{ title: 'Uptime history', hint: 'Today · 7d · 30d · 365d · all-time' },
		{ title: 'Multi-region checks', hint: 'Confirmed across eu · us before it calls down' },
		{ title: 'Alerts', hint: 'Slack, Telegram, Discord, email, PagerDuty, webhook' }
	];
	let { expired, monitor } = $derived(data);
	let tone = $derived((monitor && TONE[monitor.status]) || 'pending');
	let statusLabel = $derived(
		monitor?.status === 'up' ? 'Up' : monitor?.status === 'down' ? 'Down' : 'Checking…'
	);
	// Trials live for one hour from creation.
	let expiresAt = $derived(
		monitor ? new Date(String(monitor.created).replace(' ', 'T')).getTime() + 3_600_000 : 0
	);
	let remainingMs = $derived(Math.max(0, expiresAt - now));
	let countdown = $derived(fmtRemaining(remainingMs));
</script>

<Meta title="Your trial monitor — nabz" />

<div class="try">
	<a class="brand" href={resolve('/')} aria-label="nabz home">
		<span class="mark"
			><svg
				viewBox="0 0 24 24"
				fill="none"
				stroke="#fff"
				stroke-width="2.4"
				stroke-linecap="round"
				stroke-linejoin="round"><path d="M3 12h4l2.5-7 5 14 2.5-7H21" /></svg
			></span
		>
		<b>nabz</b>
	</a>

	{#if expired || !monitor}
		<div class="card expired">
			<h1>This trial has expired</h1>
			<p>
				Trial monitors run for one hour, then they're removed. Create a free account to start one
				that sticks around — and unlock history, multi-region checks, and alerts.
			</p>
			<div class="cta">
				<a class="btn btn-primary" href={resolve('/signup')}>Create a free account</a>
				<a class="btn btn-ghost" href={resolve('/')}>Back to home</a>
			</div>
		</div>
	{:else}
		<!-- keep-it banner: the whole point of the page -->
		<div class="keep">
			<div>
				<strong>Your trial monitor is live.</strong>
				<span class="keep-sub">Sign up to keep it — expires in <b>{countdown}</b>.</span>
			</div>
			<div class="cta">
				<a class="btn btn-primary" href={resolve('/signup')}>Sign up to keep it</a>
				<a class="btn btn-ghost" href={resolve('/signin')}>Sign in</a>
			</div>
		</div>

		<!-- the real, live bit -->
		<div class="card mon">
			<div class="mon-head">
				<div class="mon-id">
					<span class="mon-target">{monitor.target}</span>
					<span class="mon-meta"
						>Checked from the free region · every {Math.round(monitor.interval / 60)} min</span
					>
				</div>
				<Pill
					{tone}
					label={statusLabel}
					live={monitor.status === 'pending' || monitor.status === 'up'}
				/>
			</div>
			{#if monitor.status === 'pending'}
				<p class="mon-note">Running the first check… this updates on its own.</p>
			{:else}
				<p class="mon-note">
					Last checked {monitor.last_checked ? timeAgo(monitor.last_checked, now) : 'just now'}.
				</p>
			{/if}
		</div>

		<!-- locked previews: shown in full but gated behind sign-up -->
		<p class="locked-lead">Sign up to unlock the rest — free during beta:</p>
		<div class="locked-grid">
			{#each locked as w, i (i)}
				<div class="card locked">
					<div class="locked-blur" aria-hidden="true">
						<div class="skeleton-title"></div>
						<div class="skeleton-chart"></div>
						<div class="skeleton-row"></div>
						<div class="skeleton-row short"></div>
					</div>
					<div class="locked-over">
						<svg
							class="lock"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="1.8"
							stroke-linecap="round"
							stroke-linejoin="round"
							><rect x="4" y="11" width="16" height="9" rx="2" /><path
								d="M8 11V7a4 4 0 0 1 8 0v4"
							/></svg
						>
						<div class="locked-title">{w.title}</div>
						<div class="locked-hint">{w.hint}</div>
					</div>
				</div>
			{/each}
		</div>

		<p class="foot">
			Trials run for one hour and are then removed. <a href={resolve('/signup')}>Sign up</a> any time
			to keep this one.
		</p>
	{/if}
</div>

<style>
	.try {
		max-width: 760px;
		margin: 0 auto;
		padding: 28px 20px 64px;
		display: flex;
		flex-direction: column;
		gap: 16px;
	}
	.brand {
		display: inline-flex;
		align-items: center;
		gap: 9px;
		text-decoration: none;
		color: var(--text-primary);
		font-weight: 600;
		margin-bottom: 4px;
	}
	.brand .mark {
		width: 26px;
		height: 26px;
		border-radius: 6px;
		background: var(--brand);
		display: grid;
		place-items: center;
	}
	.brand .mark svg {
		width: 17px;
		height: 17px;
	}
	.card {
		background: var(--surface-1);
		border: 1px solid var(--border);
		border-radius: 4px;
		padding: 16px;
	}

	.keep {
		display: flex;
		flex-wrap: wrap;
		gap: 12px;
		align-items: center;
		justify-content: space-between;
		background: var(--brand-wash);
		border: 1px solid var(--border);
		border-left: 2px solid var(--brand);
		border-radius: 4px;
		padding: 14px 16px;
	}
	.keep strong {
		color: var(--text-primary);
	}
	.keep-sub {
		color: var(--text-secondary);
		margin-left: 4px;
	}
	.cta {
		display: flex;
		gap: 8px;
		flex-shrink: 0;
	}

	.mon-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}
	.mon-id {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}
	.mon-target {
		font-weight: 600;
		color: var(--text-primary);
		overflow-wrap: anywhere;
	}
	.mon-meta,
	.mon-note {
		color: var(--text-muted);
		font-size: 0.85rem;
	}
	.mon-note {
		margin: 10px 0 0;
	}

	.locked-lead {
		color: var(--text-secondary);
		font-weight: 500;
		margin: 6px 0 0;
	}
	.locked-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 12px;
	}
	.locked {
		position: relative;
		overflow: hidden;
		padding: 0;
		min-height: 150px;
	}
	.locked-blur {
		padding: 16px;
		filter: blur(5px);
		opacity: 0.5;
		user-select: none;
	}
	.skeleton-title {
		width: 45%;
		height: 12px;
		border-radius: 3px;
		background: var(--text-faint);
		margin-bottom: 14px;
	}
	.skeleton-chart {
		height: 60px;
		border-radius: 3px;
		background: linear-gradient(180deg, var(--brand-wash), var(--surface-2));
		border-bottom: 2px solid var(--brand-muted);
		margin-bottom: 12px;
	}
	.skeleton-row {
		height: 9px;
		border-radius: 3px;
		background: var(--border);
		margin-bottom: 8px;
	}
	.skeleton-row.short {
		width: 60%;
	}
	.locked-over {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		text-align: center;
		gap: 4px;
		padding: 12px;
		background: color-mix(in srgb, var(--surface-1) 55%, transparent);
	}
	.lock {
		width: 22px;
		height: 22px;
		color: var(--brand);
		margin-bottom: 2px;
	}
	.locked-title {
		font-weight: 600;
		color: var(--text-primary);
	}
	.locked-hint {
		font-size: 0.8rem;
		color: var(--text-muted);
		max-width: 26ch;
	}

	.expired {
		text-align: center;
		padding: 32px 20px;
	}
	.expired h1 {
		margin: 0 0 8px;
		font-size: 1.4rem;
	}
	.expired p {
		color: var(--text-secondary);
		max-width: 48ch;
		margin: 0 auto 18px;
	}
	.expired .cta {
		justify-content: center;
	}

	.foot {
		color: var(--text-muted);
		font-size: 0.85rem;
		text-align: center;
		margin: 6px 0 0;
	}
	.foot a,
	.expired a {
		color: var(--brand);
	}

	.btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 8px 14px;
		border-radius: 3px;
		font-weight: 500;
		font-size: 0.9rem;
		text-decoration: none;
		border: 1px solid transparent;
		cursor: pointer;
		white-space: nowrap;
	}
	.btn-primary {
		background: var(--brand);
		color: var(--brand-contrast);
	}
	.btn-ghost {
		background: var(--surface-1);
		border-color: var(--border);
		color: var(--text-secondary);
	}

	@media (max-width: 560px) {
		.locked-grid {
			grid-template-columns: 1fr;
		}
		.keep,
		.mon-head {
			flex-direction: column;
			align-items: flex-start;
		}
	}
</style>
