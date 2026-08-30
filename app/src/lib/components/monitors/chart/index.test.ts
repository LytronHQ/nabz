import { test, expect } from 'vitest';
import { render, screen } from '@testing-library/svelte';

import Chart from './index.svelte';

test('renders an empty state when there are no checks', () => {
	render(Chart, { checks: [] });
	expect(screen.getByText(/no checks/i)).toBeInTheDocument();
});

test('renders the phase-band areas and marks down checks', () => {
	const checks = [
		{ checked_at: '2024-01-01T00:00:00Z', response_ms: 100, up: true },
		{ checked_at: '2024-01-01T00:01:00Z', response_ms: 200, up: true },
		{ checked_at: '2024-01-01T00:02:00Z', response_ms: 150, up: false }
	];

	const { container } = render(Chart, { checks });

	// The chart draws stacked request-phase areas as <path> elements.
	expect(container.querySelectorAll('path').length).toBeGreaterThan(0);

	// The single down check gets a status-coloured marker.
	expect(container.querySelectorAll('circle.down-dot').length).toBe(1);
});

const CHECKS = [
	{ checked_at: '2024-01-01T00:00:00Z', response_ms: 100, up: true },
	{ checked_at: '2024-01-01T00:01:00Z', response_ms: 200, up: true },
	{ checked_at: '2024-01-01T00:02:00Z', response_ms: 150, up: true }
];

test('draws the latency threshold as a labelled reference line', () => {
	const { container } = render(Chart, { checks: CHECKS, latencyThresholdMs: 180 });

	const line = container.querySelector('line.threshold');
	expect(line).toBeInTheDocument();
	// Full plot width, and horizontal — a reference line, not a series.
	expect(line?.getAttribute('y1')).toBe(line?.getAttribute('y2'));
	expect(screen.getByText(/180\s*ms/i)).toBeInTheDocument();
});

test('draws nothing when slowness alerting is off', () => {
	// 0 is "disabled" in Monitor.Config, not "threshold at zero". Inventing a
	// default line would imply a threshold that will never actually fire.
	const { container } = render(Chart, { checks: CHECKS, latencyThresholdMs: 0 });
	expect(container.querySelector('line.threshold')).not.toBeInTheDocument();
});

test('omits the prop entirely and still renders', () => {
	const { container } = render(Chart, { checks: CHECKS });
	expect(container.querySelector('line.threshold')).not.toBeInTheDocument();
});

test('hides the line rather than stretching the axis to reach it', () => {
	// yTop follows the data (msMax * 1.12 ≈ 224 here). A 5000ms threshold would
	// otherwise squash every real measurement into a sliver at the bottom to make
	// room for a line nothing has come near.
	const { container } = render(Chart, { checks: CHECKS, latencyThresholdMs: 5000 });
	expect(container.querySelector('line.threshold')).not.toBeInTheDocument();
	expect(screen.queryByText(/5000\s*ms|5\s*s/i)).not.toBeInTheDocument();
});

test('draws the line in avg mode too, not just phases', () => {
	const { container } = render(Chart, { checks: CHECKS, mode: 'avg', latencyThresholdMs: 180 });
	expect(container.querySelector('line.threshold')).toBeInTheDocument();
});

test('the line is not drawn when there is no data to place it against', () => {
	const { container } = render(Chart, { checks: [], latencyThresholdMs: 180 });
	expect(container.querySelector('line.threshold')).not.toBeInTheDocument();
});

/** n samples at `normal` ms, plus any `spikes`, one minute apart. */
function series(n: number, normal: number, ...spikes: number[]) {
	const out = [];
	for (let i = 0; i < n; i++) {
		out.push({
			checked_at: new Date(Date.UTC(2024, 0, 1, 0, i)).toISOString(),
			response_ms: normal,
			up: true
		});
	}
	spikes.forEach((ms, k) =>
		out.push({
			checked_at: new Date(Date.UTC(2024, 0, 1, 1, k)).toISOString(),
			response_ms: ms,
			up: true
		})
	);
	return out;
}

// The y-axis label nearest the top tells us where the scale ended up: the ticks
// are drawn from yTop, so a capped axis produces small numbers and an
// outlier-driven one produces huge ones.
const topTick = (container: HTMLElement) =>
	Math.max(...[...container.querySelectorAll('text.axis')].map((t) => Number(t.textContent)).filter(Number.isFinite));

test('one timeout no longer sets the scale for the whole chart', () => {
	const { container } = render(Chart, { checks: series(200, 90, 22000) });
	expect(topTick(container)).toBeLessThan(1000);
});

test('a timeout seen by SEVERAL zones at once is still excluded', () => {
	// The case a percentile alone gets wrong, and the one actually reported: a
	// single outage produces one sample per zone, so the spike is a PAIR. Over 174
	// points p99 trims 1.74 samples, one of the pair survives, and the axis stayed
	// at 22,400ms on real data.
	const { container } = render(Chart, { checks: series(172, 90, 20000, 20001) });
	expect(topTick(container)).toBeLessThan(1000);
	expect(container.querySelectorAll('path.clip-mark').length).toBe(2);
});

test('ordinary slow checks are drawn, not clipped away as outliers', () => {
	// The opposite failure: a Tukey fence on the reported window lands at 203ms and
	// clips thirteen perfectly ordinary 200-320ms checks. Only genuine extremes
	// should be cut.
	const { container } = render(Chart, {
		checks: series(100, 90, 210, 257, 283, 313, 321)
	});
	expect(container.querySelectorAll('path.clip-mark').length).toBe(0);
	expect(topTick(container)).toBeGreaterThanOrEqual(321);
});

test('the outlier is marked, not silently dropped', () => {
	const { container } = render(Chart, { checks: series(200, 90, 22000) });
	expect(container.querySelectorAll('path.clip-mark').length).toBe(1);
});

test('a series with no outliers is scaled exactly as before', () => {
	// p99 == max here, so nothing is capped and nothing is marked.
	const { container } = render(Chart, { checks: series(200, 90) });
	expect(container.querySelectorAll('path.clip-mark').length).toBe(0);
	expect(topTick(container)).toBeGreaterThanOrEqual(90);
	expect(topTick(container)).toBeLessThan(200);
});

test('a short window keeps its own peak rather than clipping it', () => {
	// With few points the p99 rank IS the maximum: an hour of data with one slow
	// check must still show that check, not hide it behind a marker.
	const { container } = render(Chart, { checks: series(5, 90, 900) });
	expect(container.querySelectorAll('path.clip-mark').length).toBe(0);
});

test('the threshold line survives the new scale, and still hides above it', () => {
	// Capping the axis is what makes a 100ms threshold visible against 90ms of
	// traffic in the first place — previously it sat on the baseline under a 22s spike.
	const within = render(Chart, { checks: series(200, 90, 22000), latencyThresholdMs: 100 });
	expect(within.container.querySelector('line.threshold')).toBeInTheDocument();

	// Above the CAPPED yTop, so hidden — even though it is far below the raw max.
	const above = render(Chart, { checks: series(200, 90, 22000), latencyThresholdMs: 5000 });
	expect(above.container.querySelector('line.threshold')).not.toBeInTheDocument();
});

test('clipping applies in avg mode too', () => {
	const { container } = render(Chart, { checks: series(200, 90, 22000), mode: 'avg' });
	expect(container.querySelectorAll('path.clip-mark').length).toBe(1);
	expect(topTick(container)).toBeLessThan(1000);
});

test('down checks keep their own marker', () => {
	const checks = series(200, 90, 22000);
	checks[3].up = false;
	const { container } = render(Chart, { checks });
	expect(container.querySelectorAll('circle.down-dot').length).toBe(1);
});

test('draws smooth curves rather than straight segments', () => {
	const { container } = render(Chart, { checks: series(20, 90, 150) });
	const paths = [...container.querySelectorAll('path')].map((p) => p.getAttribute('d') ?? '');
	const bands = paths.filter((d) => d.startsWith('M'));
	expect(bands.length).toBeGreaterThan(0);
	// Cubics, and no polyline segments left anywhere in the band outlines.
	expect(bands.some((d) => d.includes('C'))).toBe(true);
	for (const d of bands) expect(d).not.toMatch(/L\d/);
});

test('smooths in avg mode too', () => {
	const { container } = render(Chart, { checks: series(20, 90, 150), mode: 'avg' });
	const d = container.querySelector('path')?.getAttribute('d') ?? '';
	expect(d).toContain('C');
});

test('a single check still renders without a curve', () => {
	// Two points are needed for a segment; one must not throw or emit a broken path.
	const { container } = render(Chart, {
		checks: [{ checked_at: '2024-01-01T00:00:00Z', response_ms: 90, up: true }]
	});
	expect(container.querySelector('svg')).toBeInTheDocument();
});
