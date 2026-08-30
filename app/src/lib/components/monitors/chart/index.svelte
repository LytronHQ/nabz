<script lang="ts">
	import { formatMs } from '$lib/utils/format-utils';
	import {
		monotoneSegments,
		forwardPath,
		reversePath,
		type Segment
	} from '$lib/utils/monotone-path';

	// 'phases' stacks DNS/Connect/TLS/Transfer from raw checks; 'avg' draws a single
	// average-response area — used for the rollup-backed Week/Month ranges, which

	interface Props {
		checks?: Array<{
			checked_at: string;
			response_ms: number;
			dns_ms?: number;
			connect_ms?: number;
			tls_ms?: number;
			ttfb_ms?: number;
			up: boolean;
		}>;
		height?: number;
		// have no phase breakdown.
		mode?: 'phases' | 'avg';
		/** Monitor.Config.LatencyThresholdMs — the p95 the evaluator alerts on.
		 *  0/undefined means slowness alerting is off, and then nothing is drawn:
		 *  a made-up default line would imply a threshold that will never fire. */
		latencyThresholdMs?: number;
	}

	let { checks = [], height = 240, mode = 'phases', latencyThresholdMs = 0 }: Props = $props();

	// Request phases, stacked baseline→top in the order a request happens.
	// "Data transfer" is the remainder after DNS+Connect+TLS, so the stack always
	// sums to the total response time (a reused keep-alive connection has 0 for the
	// first three, leaving transfer = the whole response).
	const PHASE_SERIES = [
		{ key: 'dns', label: 'Name lookup', color: 'var(--phase-dns)' },
		{ key: 'connect', label: 'Connection', color: 'var(--phase-connect)' },
		{ key: 'tls', label: 'TLS handshake', color: 'var(--phase-tls)' },
		{ key: 'transfer', label: 'Data transfer', color: 'var(--phase-transfer)' }
	];
	const AVG_SERIES = [{ key: 'avg', label: 'Avg response', color: 'var(--accent)' }];

	const padL = 44;
	const padR = 12;
	const padT = 16;
	const padB = 24;

	let width = $state(800);
	// Unique per instance — a shared id would make one chart clip to another's box.
	const clipId = `chart-clip-${Math.random().toString(36).slice(2, 9)}`;

	let hover: { x: number; t: number; up: boolean; seg: number[]; total: number } | null =
		$state(null);

	const xOf = (t: number) => padL + (tMax === tMin ? 0.5 : (t - tMin) / (tMax - tMin)) * innerW;
	const yOf = (ms: number) => padT + (1 - ms / yTop) * innerH;
	// For markers, which are points rather than filled areas and so cannot be
	// clipped away without vanishing: pin them to the top edge instead. A down
	// check that also timed out still has to be visible.
	const yClamped = (ms: number) => Math.max(padT, yOf(ms));

	// cumulative height at boundary k (0..4): sum of the first k segments
	const cum = (seg: number[], k: number) => seg.slice(0, k).reduce((a, b) => a + b, 0);

	type Pt = { t: number; up: boolean; seg: number[]; total: number };

	// Pure path builders — EVERY input is an argument so the reactive statements
	// below list them as dependencies. (Svelte doesn't trace reactive vars read
	// inside a function body, only those named in the `$:` statement itself.)
	//
	// Smoothing happens on the CUMULATIVE outlines (dns, dns+connect, +tls, total),
	// not on each phase separately. Each band is then drawn between two adjacent
	// smoothed outlines, so neighbouring layers share an edge exactly and cannot
	// cross — smoothing the phases independently would let a lower band's curve
	// wander above the one stacked on it.
	function outlineSegments(
		points: Pt[],
		k: number,
		w: number,
		top: number,
		t0: number,
		t1: number,
		h: number
	): Segment[] {
		const iw = Math.max(1, w - padL - padR);
		const ih = Math.max(1, h - padT - padB);
		const x = (t: number) => padL + (t1 === t0 ? 0.5 : (t - t0) / (t1 - t0)) * iw;
		const y = (ms: number) => padT + (1 - ms / top) * ih;
		return monotoneSegments(points.map((p) => ({ x: x(p.t), y: y(cum(p.seg, k)) })));
	}

	/** A filled band between cumulative outlines k and k+1: along the top edge, back
	 *  along the bottom one. */
	function bandPathFrom(upper: Segment[], lower: Segment[]): string {
		if (!upper.length || !lower.length) return '';
		return `${forwardPath(upper)}${reversePath(lower)} Z`;
	}

	/** Where to cap the y-axis: the largest plotted value, unless that value is an
	 *  extreme outlier, in which case a multiple of the p95.
	 *
	 *  The axis used to follow the raw maximum, so ONE timeout set the scale for
	 *  everything: a 20-second spike against 80-100ms of normal traffic pushed the
	 *  real data — and the latency threshold line — onto the baseline.
	 *
	 *  A percentile alone does NOT fix that, which is worth spelling out because it
	 *  is the obvious answer and it fails. Outliers arrive one per ZONE: a single
	 *  timeout on a two-zone monitor is two samples. Over a 174-point window, p99
	 *  trims 1.74 samples, so one of the pair survives into the percentile and the
	 *  axis is still 22,400ms. Measured on exactly that data.
	 *
	 *  A Tukey fence (q3 + 1.5*iqr) overcorrects in the other direction: on the same
	 *  window it lands at 203ms and clips fifteen samples, thirteen of them ordinary
	 *  200-320ms checks that deserve to be drawn.
	 *
	 *  So the cutoff is deliberately generous — 10x the p95 — and it is used only to
	 *  DECIDE what counts as an outlier. The axis is then set to the largest value
	 *  that is not one, rather than to the cutoff itself.
	 *
	 *  That separation is what makes both cases work. A tight cutoff scaled to
	 *  itself clips real data: 100 checks at a flat 90ms give a p95 of 90, so a 321ms
	 *  check is "3.5x the p95" and would be cut, though it is plainly a real
	 *  measurement. A generous cutoff scaled to itself leaves the axis far above
	 *  everything drawn. Choosing extremes generously, then fitting tightly to what
	 *  remains, does neither.
	 *
	 *  On the reported window: p95 216ms, cutoff 2160ms, so the two 20-second samples
	 *  are outliers and the axis lands on the 321ms next-largest — every real check
	 *  visible, the timeout marked. A series with no outliers keeps its own maximum
	 *  and is scaled exactly as before. */
	function axisCeiling(values: number[]): number {
		if (!values.length) return 1;
		const sorted = [...values].sort((a, b) => a - b);
		const max = sorted[sorted.length - 1];
		// Nearest rank, so the value is always one a check actually recorded.
		const p95 = sorted[Math.max(0, Math.ceil(0.95 * sorted.length) - 1)];
		// A flat series (p95 === 0) has no spread to reason about; keep the max.
		if (p95 <= 0) return Math.max(1, max);
		const cutoff = p95 * 10;
		if (max <= cutoff) return Math.max(1, max);
		// The tallest sample that is not an extreme — never below the p95, so a
		// window that is ALL outliers still has a sane axis.
		const kept = sorted.filter((v) => v <= cutoff);
		return Math.max(1, kept.length ? kept[kept.length - 1] : p95);
	}

	function buildTicks(top: number, ih: number): { v: number; y: number }[] {
		const steps = 4;
		const out: { v: number; y: number }[] = [];
		for (let i = 1; i <= steps; i++) {
			const v = (top / steps) * i;
			out.push({ v, y: padT + (1 - v / top) * ih });
		}
		return out;
	}

	function timeLabel(t: number) {
		const d = new Date(t);
		// Multi-day spans read better as dates; short spans as clock times.
		if (tMax - tMin > 2 * 86_400_000)
			return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
		return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	}

	function onMove(e: MouseEvent) {
		if (!pts.length) return;
		const rect = (e.currentTarget as SVGElement).getBoundingClientRect();
		const x = e.clientX - rect.left;
		let best = 0;
		let bestD = Infinity;
		for (let i = 0; i < pts.length; i++) {
			const d = Math.abs(xOf(pts[i].t) - x);
			if (d < bestD) {
				bestD = d;
				best = i;
			}
		}
		const p = pts[best];
		hover = { x: xOf(p.t), t: p.t, up: p.up, seg: p.seg, total: p.total };
	}
	const onLeave = () => (hover = null);
	let series = $derived(mode === 'avg' ? AVG_SERIES : PHASE_SERIES);
	let pts = $derived(
		checks
			.map((c) => {
				if (mode === 'avg') {
					const ms = Math.max(0, c.response_ms ?? 0);
					return { t: new Date(c.checked_at).getTime(), up: c.up ?? true, seg: [ms], total: ms };
				}
				const dns = Math.max(0, c.dns_ms ?? 0);
				const connect = Math.max(0, c.connect_ms ?? 0);
				const tls = Math.max(0, c.tls_ms ?? 0);
				const total = Math.max(0, c.response_ms ?? 0);
				const transfer = Math.max(0, total - dns - connect - tls);
				const seg = [dns, connect, tls, transfer];
				return {
					t: new Date(c.checked_at).getTime(),
					up: !!c.up,
					seg,
					total: dns + connect + tls + transfer
				};
			})
			.filter((p) => Number.isFinite(p.t))
	);
	let tMin = $derived(pts.length ? pts[0].t : 0);
	let tMax = $derived(pts.length ? pts[pts.length - 1].t : 1);
	let msMax = $derived(pts.reduce((m, p) => Math.max(m, p.total), 1));
	// Headroom over the p99, not over the max — see p99(). Never below 1, and never
	// above the max, so a series with no outliers is scaled exactly as before.
	let yTop = $derived(axisCeiling(pts.map((p) => p.total)) * 1.12);
	// Samples the axis cannot show. Drawn as markers at the top edge so the chart
	// never silently pretends a spike did not happen — the point of capping is to
	// make the normal data readable, not to hide the outlier.
	let clipped = $derived(pts.filter((p) => p.total > yTop));
	let innerW = $derived(Math.max(1, width - padL - padR));
	let innerH = $derived(Math.max(1, height - padT - padB));
	let baseline = $derived(padT + innerH);
	// One smoothed outline per cumulative level, 0..series.length. Level 0 is the
	// baseline; every band and separator is built from these, so the whole stack is
	// derived from a single set of curves.
	let outlines = $derived(
		Array.from({ length: series.length + 1 }, (_, k) =>
			outlineSegments(pts, k, width, yTop, tMin, tMax, height)
		)
	);
	let bands = $derived(
		series.map((s, i) => ({ ...s, d: bandPathFrom(outlines[i + 1], outlines[i]) }))
	);
	let separators = $derived(
		series.length > 1 ? series.slice(1).map((_, k) => forwardPath(outlines[k + 1])) : []
	);
	let yTicks = $derived(buildTicks(yTop, innerH));
	// The threshold line, or null when there is nothing to draw.
	//
	// Deliberately NOT allowed to stretch the axis: yTop follows the observed data
	// (msMax * 1.12), and a threshold far above everything recorded would flatten
	// every real measurement into a sliver at the bottom to make room for a line
	// nothing has approached. Above the axis, it is simply not drawn — the shape of
	// the data is what the chart is for.
	let thresholdY = $derived(
		latencyThresholdMs > 0 && pts.length > 0 && latencyThresholdMs <= yTop
			? yOf(latencyThresholdMs)
			: null
	);
	let downPts = $derived(pts.filter((p) => !p.up));
	let last = $derived(pts.length ? pts[pts.length - 1] : null);
</script>

<div class="chart" bind:clientWidth={width}>
	{#if pts.length === 0}
		<div class="empty" style="height:{height}px">No checks in this window yet.</div>
	{:else}
		<svg
			role="img"
			aria-label="Response time by request phase over time"
			{width}
			{height}
			onmousemove={onMove}
			onmouseleave={onLeave}
		>
			{#each yTicks as tick, i (i)}
				<line x1={padL} x2={width - padR} y1={tick.y} y2={tick.y} class="grid" />
				<text x={padL - 8} y={tick.y - 3} text-anchor="end" class="axis">{Math.round(tick.v)}</text>
			{/each}

			<text x={padL} y={height - 6} text-anchor="start" class="axis">{timeLabel(tMin)}</text>
			<text x={width - padR} y={height - 6} text-anchor="end" class="axis">{timeLabel(tMax)}</text>

			<defs>
				<clipPath id={clipId}>
					<rect x={padL} y={padT} width={Math.max(1, width - padL - padR)} height={innerH} />
				</clipPath>
			</defs>
			<!-- Clipped to the plot area: with the axis capped at the p99, an outlier's
			     band runs off the top, and without this it would paint over the ticks
			     and out of the card entirely. -->
			<g clip-path="url(#{clipId})">
				{#each bands as band, i (i)}
					<path d={band.d} fill={band.color} fill-opacity="0.9" />
				{/each}
				{#each separators as sep, i (i)}
					<path d={sep} fill="none" class="sep" />
				{/each}
			</g>

			{#each clipped as p, i (i)}
				<!-- An up-chevron at the top edge: this sample is off the scale. Muted
				     and open, so it never reads as a status marker the way the filled
				     red down-dot does. Its real value is in the hover tooltip. -->
				<path
					class="clip-mark"
					d="M{(xOf(p.t) - 4).toFixed(1)} {padT + 5} L{xOf(p.t).toFixed(1)} {padT} L{(xOf(p.t) + 4).toFixed(1)} {padT + 5}"
				/>
			{/each}

			{#if thresholdY != null}
				<!-- Drawn after the bands so it reads over them, before the status dots
				     so a down marker is never hidden behind it. -->
				<line
					x1={padL}
					x2={width - padR}
					y1={thresholdY}
					y2={thresholdY}
					class="threshold"
				/>
				<text x={width - padR} y={thresholdY - 4} text-anchor="end" class="axis threshold-label">
					{formatMs(latencyThresholdMs)}
				</text>
			{/if}

			{#each downPts as p, i (i)}
				<circle cx={xOf(p.t)} cy={yClamped(p.total)} r="3.5" class="down-dot" />
			{/each}

			{#if last}
				<circle cx={xOf(last.t)} cy={yClamped(last.total)} r="5" class="end-halo" />
				<circle cx={xOf(last.t)} cy={yClamped(last.total)} r="3" class="end-dot" />
			{/if}

			{#if hover}
				<line x1={hover.x} x2={hover.x} y1={padT} y2={height - padB} class="cross" />
				<circle
					cx={hover.x}
					cy={yClamped(hover.total)}
					r="4"
					class={hover.up ? 'end-dot' : 'down-dot'}
				/>
			{/if}
		</svg>

		<div class="legend">
			{#each series as s, i (i)}
				<span class="item">
					<span class="sw" style="background:{s.color}"></span>
					{s.label}
					{#if last}<b>{formatMs(last.seg[i])}</b>{/if}
				</span>
			{/each}
		</div>

		{#if hover}
			<div class="tip" style="left:{Math.min(Math.max(hover.x, 92), width - 92)}px">
				<div class="tip__h">{hover.up ? 'up' : 'down'} · {timeLabel(hover.t)}</div>
				{#each series as s, i (i)}
					<div class="tip__row">
						<span class="sw" style="background:{s.color}"></span>
						<span class="lbl">{s.label}</span>
						<b>{formatMs(hover.seg[i])}</b>
					</div>
				{/each}
				{#if series.length > 1}
					<div class="tip__row tip__total">
						<span class="lbl">Total</span>
						<b>{formatMs(hover.total)}</b>
					</div>
				{/if}
				{#if hover.total > yTop}
					<!-- The value above is the real one; the drawing is not. Say so, rather
					     than letting a band that stops at the top edge imply this sample
					     merely reached the top of the scale. -->
					<div class="tip__row tip__clip">off scale — clipped to fit</div>
				{/if}
			</div>
		{/if}
	{/if}
</div>

<style>
	.chart {
		position: relative;
		width: 100%;
	}
	.empty {
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 13px;
		color: var(--ink-3);
	}
	svg {
		display: block;
		width: 100%;
	}
	.grid {
		stroke: var(--border);
		stroke-width: 1;
		opacity: 0.7;
	}
	.axis {
		fill: var(--ink-3);
		font-size: 10px;
		font-family: inherit;
	}
	.sep {
		stroke: var(--surface);
		stroke-width: 2;
		stroke-linejoin: round;
	}
	/* The pending/warning token, not up-green or down-red: those two carry a
	   specific meaning in this app and a threshold is neither. Dashed to match the
	   hairline-and-dashed idiom of the design system, and to read as an annotation
	   over the data rather than as another series. */
	.threshold {
		stroke: var(--status-pending);
		stroke-width: 1;
		stroke-dasharray: 4 3;
		opacity: 0.9;
	}
	.threshold-label {
		fill: var(--status-pending);
		/* The label sits ON the bands, and amber on the transfer green is about
		   1.3:1 — technically drawn, effectively unreadable. paint-order draws a
		   surface-coloured stroke UNDER the glyphs, giving a halo that separates
		   them from whatever band happens to be behind, in either theme. Cheaper
		   than a backing rect and it needs no layout maths. */
		stroke: var(--surface);
		stroke-width: 3px;
		paint-order: stroke;
		stroke-linejoin: round;
	}
	.cross {
		stroke: var(--border-strong);
		stroke-width: 1;
	}
	.clip-mark {
		fill: none;
		stroke: var(--ink-3);
		stroke-width: 1.5;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.tip__clip {
		color: var(--ink-3);
		font-style: italic;
	}
	.down-dot {
		fill: var(--down);
		stroke: var(--surface);
		stroke-width: 1.5;
	}
	.end-dot {
		fill: var(--ink);
		stroke: var(--surface);
		stroke-width: 1.5;
	}
	.end-halo {
		fill: var(--ink);
		opacity: 0.14;
	}

	.legend {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 16px;
		padding: 10px 6px 2px;
	}
	.legend .item {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		font-size: 12px;
		color: var(--ink-2);
	}
	.legend .item b {
		color: var(--ink);
		font-family: inherit;
		font-size: 12px;
	}
	.sw {
		width: 10px;
		height: 10px;
		border-radius: 3px;
		flex: 0 0 10px;
	}

	.tip {
		position: absolute;
		top: 0;
		transform: translateX(-50%);
		background: var(--surface);
		color: var(--ink);
		border: 1px solid var(--border);
		box-shadow: var(--shadow);
		border-radius: var(--radius-btn);
		padding: 7px 10px;
		pointer-events: none;
		font-size: 11.5px;
		white-space: nowrap;
		min-width: 150px;
	}
	.tip__h {
		color: var(--ink-3);
		font-family: inherit;
		margin-bottom: 5px;
	}
	.tip__row {
		display: flex;
		align-items: center;
		gap: 7px;
		padding: 1.5px 0;
	}
	.tip__row .lbl {
		color: var(--ink-2);
	}
	.tip__row b {
		margin-left: auto;
		font-family: inherit;
	}
	.tip__total {
		margin-top: 4px;
		padding-top: 5px;
		border-top: 1px solid var(--border);
	}
	.tip__total .lbl {
		color: var(--ink);
		font-weight: 600;
	}
</style>
