<script lang="ts">
	import { formatDuration } from '$lib/utils/format-utils';

	type Interval = { s: number; e: number };
	type Range = {
		key: '24h' | '7d' | '30d';
		label: string;
		availability: number | null;
		downtimeMs: number;
		incidents: number;
		fromMs: number;
		toMs: number;
		dataStartMs: number;
		down: Interval[];
	};

	interface Props {
		ranges?: Range[];
	}

	let { ranges = [] }: Props = $props();

	let selected: '24h' | '7d' | '30d' = $state('24h');
	let cur = $derived(ranges.find((r) => r.key === selected) ?? ranges[0]);

	// "Healthy" (green uptime figure) = full availability within rounding. Any real
	// downtime drops it to neutral ink; the bar carries the red, not the number.
	let healthy = $derived(cur?.availability != null && cur.availability >= 99.9);

	const fmtPct = (v: number | null | undefined) => (v == null ? '—' : `${v}%`);
	const fmtDown = (ms: number) => (ms > 0 ? formatDuration(ms / 1000) : 'None');
	// Matches fmtDown's vocabulary. "0" next to "None" for the same empty state,
	// two figures apart in the same card, reads like two different measurements.
	const fmtIncidents = (n: number | undefined) => (n && n > 0 ? String(n) : 'None');

	// The bar is a fixed number of equal segments across the window; each is red if
	// an incident overlaps it, muted if it predates the monitor's first data, else
	// green. Incident timestamps are exact, so red placement is precise regardless
	// of rollup granularity.
	const SEGMENTS = 48;
	type Seg = { state: 'up' | 'down' | 'nodata'; title: string };

	function buildSegments(r: Range | undefined): Seg[] {
		if (!r) return [];
		const span = r.toMs - r.fromMs;
		if (span <= 0) return [];
		const step = span / SEGMENTS;
		const out: Seg[] = [];
		for (let i = 0; i < SEGMENTS; i++) {
			const s = r.fromMs + i * step;
			const e = s + step;
			let state: Seg['state'] = 'up';
			if (e <= r.dataStartMs) state = 'nodata';
			else if (r.down.some((d) => d.s < e && d.e > s)) state = 'down';
			const when = new Date(s).toLocaleString([], {
				month: 'short',
				day: 'numeric',
				hour: '2-digit',
				minute: '2-digit'
			});
			const label = state === 'down' ? 'Down' : state === 'nodata' ? 'No data' : 'Up';
			out.push({ state, title: `${label} · ${when}` });
		}
		return out;
	}
	let segs = $derived(buildSegments(cur));
</script>

<div class="card avail">
	<div class="chart-legend">
		<span class="t">Availability</span>
		<div class="seg">
			{#each ranges as r, i (i)}
				<button class:on={selected === r.key} onclick={() => (selected = r.key)}>{r.label}</button>
			{/each}
		</div>
	</div>

	<div class="figs">
		<div class="fig">
			<div class="fig-label">Uptime</div>
			<div class="fig-val" class:ok={healthy}>{fmtPct(cur?.availability)}</div>
		</div>
		<div class="fig">
			<div class="fig-label">Downtime</div>
			<div class="fig-val" class:bad={(cur?.downtimeMs ?? 0) > 0}>
				{fmtDown(cur?.downtimeMs ?? 0)}
			</div>
		</div>
		<div class="fig">
			<div class="fig-label">Incidents</div>
			<div class="fig-val">{fmtIncidents(cur?.incidents)}</div>
		</div>
	</div>

	<div class="bar" role="img" aria-label={`Uptime over the last ${cur?.label ?? ''}`}>
		{#each segs as sg, i (i)}
			<span class="tick {sg.state}" title={sg.title}></span>
		{/each}
	</div>
	<div class="axis">
		<span>{cur?.label} ago</span>
		<span>now</span>
	</div>
</div>

<style>
	.avail {
		padding: 14px 16px 12px;
	}
	.figs {
		display: flex;
		gap: 28px;
		margin: 14px 2px 16px;
		flex-wrap: wrap;
	}
	.fig-label {
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.07em;
		color: var(--text-muted);
	}
	.fig-val {
		font-family: var(--font-stat);
		font-variant-numeric: tabular-nums;
		font-size: 24px;
		line-height: 1.15;
		margin-top: 3px;
		color: var(--text-primary);
	}
	.fig-val.ok {
		color: var(--status-up);
	}
	.fig-val.bad {
		color: var(--status-down);
	}
	.bar {
		display: flex;
		gap: 1px;
		height: 34px;
		width: 100%;
	}
	.tick {
		flex: 1 1 0;
		min-width: 0;
		background: var(--status-up);
	}
	.tick.down {
		background: var(--status-down);
	}
	.tick.nodata {
		background: var(--border);
	}
	.tick:first-child {
		border-top-left-radius: 2px;
		border-bottom-left-radius: 2px;
	}
	.tick:last-child {
		border-top-right-radius: 2px;
		border-bottom-right-radius: 2px;
	}
	.axis {
		display: flex;
		justify-content: space-between;
		margin-top: 6px;
		font-size: 11px;
		color: var(--text-muted);
	}
</style>
