<script lang="ts">
	import { refreshAll } from '$app/navigation';
	import { Pill } from '#lib/components/common/index.js';
	import type { PillTone } from '#lib/components/common/pill/index.js';
	import { usePoll } from '#lib/utils/use-poll.js';
	import { formatDuration } from '#lib/utils/format-utils.js';

	let { data } = $props();
	let p = $derived(data.page);

	// Visitors keep this open during an outage; a minute is fresh enough.
	usePoll(() => refreshAll(), 60_000);

	const OVERALL = {
		up: { text: 'All systems operational', cls: 'up' },
		down: { text: 'Some systems are down', cls: 'down' },
		pending: { text: 'Checking the systems', cls: 'pend' }
	} as const;
	let overall = $derived(OVERALL[p.overall]);

	const STATE: Record<string, { tone: PillTone; label: string }> = {
		up: { tone: 'up', label: 'Up' },
		down: { tone: 'down', label: 'Down' },
		pending: { tone: 'pending', label: 'Checking' },
		paused: { tone: 'paused', label: 'Paused' }
	};

	// One segment per calendar day, today last: red if an incident touched that
	// day, muted before the monitor's first data, green otherwise. Rolling 24 h
	// slices made a 5-minute incident paint two "days" when it crossed a slice
	// boundary at the current clock time.
	const DAYS = 30;
	const DAY_MS = 86_400_000;
	type Seg = { state: 'up' | 'down' | 'nodata'; title: string };
	function segments(m: (typeof p.monitors)[number]): Seg[] {
		const today = new Date(p.generatedAt);
		today.setHours(0, 0, 0, 0);
		return Array.from({ length: DAYS }, (_, i) => {
			const day = new Date(today);
			day.setDate(today.getDate() - (DAYS - 1 - i));
			const s = day.getTime();
			const e = Math.min(s + DAY_MS, p.generatedAt);
			const state: Seg['state'] =
				e <= m.dataStartMs ? 'nodata' : m.down.some((d) => d.s < e && d.e > s) ? 'down' : 'up';
			const label = day.toLocaleDateString([], { month: 'short', day: 'numeric' });
			return {
				state,
				title: `${label}: ${state === 'down' ? 'downtime' : state === 'nodata' ? 'no data' : 'up'}`
			};
		});
	}

	const when = (v: string) =>
		new Date(v.replace(' ', 'T')).toLocaleString([], {
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});
	const lasted = (a: string, b: string | null) =>
		b
			? formatDuration(
					(new Date(b.replace(' ', 'T')).getTime() - new Date(a.replace(' ', 'T')).getTime()) / 1000
				)
			: null;
	const pct = (v: number | null) => (v == null ? '—' : `${v}%`);
	let updated = $derived(
		new Date(p.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
	);
</script>

<svelte:head>
	<title>{p.title} status</title>
	<meta name="description" content={p.description || `Current status of ${p.title}.`} />
</svelte:head>

<div class="sp">
	<header class="sp-head">
		<h1>{p.title}</h1>
		{#if p.description}<p class="sp-desc">{p.description}</p>{/if}
	</header>

	<div class="sp-overall {overall.cls}" role="status">
		<i class="glyph" aria-hidden="true"></i>{overall.text}
	</div>

	<section class="card sp-card" aria-labelledby="sp-services">
		<div class="card__h">
			<h3 id="sp-services">Services</h3>
			<span class="hint">last 30 days</span>
		</div>
		<ul class="sp-list">
			{#each p.monitors as m (m.id)}
				<li class="sp-mon">
					<div class="sp-mon__top">
						<span class="sp-mon__name">{m.name}</span>
						<span class="sp-mon__pct">{pct(m.uptime30d)}</span>
						<Pill tone={STATE[m.state].tone} label={STATE[m.state].label} />
					</div>
					<div
						class="sp-bar"
						role="img"
						aria-label={`${m.name}: ${pct(m.uptime30d)} uptime over 30 days`}
					>
						{#each segments(m) as sg, i (i)}
							<span class="tick {sg.state}" title={sg.title}></span>
						{/each}
					</div>
					<div class="sp-axis"><span>30 days ago</span><span>today</span></div>
				</li>
			{/each}
		</ul>
	</section>

	<section class="card sp-card" aria-labelledby="sp-incidents">
		<div class="card__h">
			<h3 id="sp-incidents">Incidents</h3>
			<span class="hint">last 30 days</span>
		</div>
		{#if p.incidents.length === 0}
			<p class="sp-empty">No incidents in the last 30 days.</p>
		{:else}
			<ul class="sp-list">
				{#each p.incidents as inc, i (i)}
					<li class="sp-inc">
						<span class="sp-inc__name">{inc.monitor}</span>
						<span class="sp-inc__when">
							{when(inc.startedAt)}
							{#if inc.resolvedAt}· lasted {lasted(inc.startedAt, inc.resolvedAt)}{:else}·
								<b class="sp-ongoing">ongoing</b>{/if}
						</span>
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	<footer class="sp-foot">
		<span>Updated {updated}</span>
		{#if p.poweredBy}
			<span>Powered by <a href="https://nabz.sh/">nabz</a>, uptime monitoring</span>
		{/if}
	</footer>
</div>

<style>
	.sp {
		max-width: 760px;
		margin: 0 auto;
		padding: 40px 16px 32px;
		display: flex;
		flex-direction: column;
		gap: 18px;
	}
	.sp-head h1 {
		font-size: 28px;
		line-height: 1.2;
		margin: 0;
		color: var(--ink);
		overflow-wrap: anywhere;
	}
	.sp-desc {
		margin: 8px 0 0;
		color: var(--ink-3);
		font-size: 15px;
		overflow-wrap: anywhere;
	}
	.sp-overall {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 14px 16px;
		border: 1px solid var(--border);
		border-radius: var(--radius-btn);
		font-size: 16px;
		font-weight: 600;
		color: var(--ink);
	}
	.sp-overall .glyph {
		width: 10px;
		height: 10px;
		border-radius: 50%;
		flex: 0 0 10px;
	}
	.sp-overall.up {
		background: var(--up-wash);
	}
	.sp-overall.up .glyph {
		background: var(--up);
	}
	.sp-overall.down {
		background: var(--down-wash);
	}
	.sp-overall.down .glyph {
		background: var(--down);
	}
	.sp-overall.pend {
		background: var(--pending-wash);
	}
	.sp-overall.pend .glyph {
		background: var(--pending);
	}
	.sp-list {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.sp-mon {
		padding: 14px 16px;
		border-bottom: 1px solid var(--border);
	}
	.sp-mon:last-child,
	.sp-inc:last-child {
		border-bottom: 0;
	}
	.sp-mon__top {
		display: flex;
		align-items: center;
		gap: 12px;
		margin-bottom: 10px;
	}
	.sp-mon__name {
		flex: 1 1 auto;
		min-width: 0;
		font-weight: 560;
		color: var(--ink);
		overflow-wrap: anywhere;
	}
	.sp-mon__pct {
		font-variant-numeric: tabular-nums;
		color: var(--ink-3);
		font-size: 13px;
	}
	.sp-bar {
		display: flex;
		gap: 2px;
		height: 28px;
	}
	.tick {
		flex: 1 1 0;
		min-width: 0;
		background: var(--up);
		border-radius: 1px;
	}
	.tick.down {
		background: var(--down);
	}
	.tick.nodata {
		background: var(--border);
	}
	.sp-axis {
		display: flex;
		justify-content: space-between;
		margin-top: 6px;
		font-size: 11px;
		color: var(--ink-3);
	}
	.sp-inc {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		gap: 4px 12px;
		padding: 12px 16px;
		border-bottom: 1px solid var(--border);
		font-size: 14px;
	}
	.sp-inc__name {
		font-weight: 560;
		color: var(--ink);
		overflow-wrap: anywhere;
	}
	.sp-inc__when {
		color: var(--ink-3);
		font-variant-numeric: tabular-nums;
	}
	.sp-ongoing {
		color: var(--down);
		font-weight: 600;
	}
	.sp-empty {
		margin: 0;
		padding: 14px 16px;
		color: var(--ink-3);
		font-size: 14px;
	}
	.sp-foot {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		gap: 6px 16px;
		font-size: 12px;
		color: var(--ink-3);
		padding: 0 2px;
	}
	.sp-foot a {
		color: var(--accent);
	}
	@media (max-width: 480px) {
		.sp {
			padding-top: 24px;
		}
		.sp-head h1 {
			font-size: 23px;
		}
	}
</style>
