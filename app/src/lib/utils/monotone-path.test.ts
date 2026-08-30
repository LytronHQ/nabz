import { describe, it, expect } from 'vitest';
import { monotoneSegments, forwardPath, reversePath, type Point, type Segment } from './monotone-path';

/** Evaluate a cubic Bézier at t. */
function at(s: Segment, t: number): Point {
	const u = 1 - t;
	const b0 = u * u * u,
		b1 = 3 * u * u * t,
		b2 = 3 * u * t * t,
		b3 = t * t * t;
	return {
		x: b0 * s.x0 + b1 * s.c1x + b2 * s.c2x + b3 * s.x1,
		y: b0 * s.y0 + b1 * s.c1y + b2 * s.c2y + b3 * s.y1
	};
}

/** Densely sampled ys of one segment. */
const ys = (s: Segment, n = 60) => Array.from({ length: n + 1 }, (_, i) => at(s, i / n).y);

const pts = (...ys: number[]): Point[] => ys.map((y, i) => ({ x: i * 10, y }));

describe('monotoneSegments', () => {
	it('passes exactly through every sample', () => {
		const input = pts(40, 90, 55, 120, 70);
		const segs = monotoneSegments(input);
		expect(segs).toHaveLength(input.length - 1);
		segs.forEach((s, i) => {
			expect(s.x0).toBeCloseTo(input[i].x, 6);
			expect(s.y0).toBeCloseTo(input[i].y, 6);
			expect(s.x1).toBeCloseTo(input[i + 1].x, 6);
			expect(s.y1).toBeCloseTo(input[i + 1].y, 6);
		});
	});

	it('never overshoots a spike', () => {
		// The reason this is monotone cubic and not Catmull-Rom: on a spike, a plain
		// spline swings above the peak and below the shoulders, drawing values that
		// were never measured. With a threshold line on the chart, an invented dip
		// below it would show a breach that did not happen.
		const input = pts(10, 10, 100, 10, 10);
		for (const s of monotoneSegments(input)) {
			const lo = Math.min(s.y0, s.y1);
			const hi = Math.max(s.y0, s.y1);
			for (const y of ys(s)) {
				expect(y).toBeGreaterThanOrEqual(lo - 1e-9);
				expect(y).toBeLessThanOrEqual(hi + 1e-9);
			}
		}
	});

	it('stays flat across equal samples instead of bulging', () => {
		for (const s of monotoneSegments(pts(50, 50, 50, 90))) {
			if (s.y0 === s.y1) for (const y of ys(s)) expect(y).toBeCloseTo(s.y0, 9);
		}
	});

	it('is monotone within a rising or falling run', () => {
		const segs = monotoneSegments(pts(10, 30, 60, 61, 200));
		for (const s of segs) {
			const seq = ys(s);
			const rising = s.y1 >= s.y0;
			for (let i = 1; i < seq.length; i++) {
				if (rising) expect(seq[i]).toBeGreaterThanOrEqual(seq[i - 1] - 1e-9);
				else expect(seq[i]).toBeLessThanOrEqual(seq[i - 1] + 1e-9);
			}
		}
	});

	it('drops duplicate x rather than dividing by zero', () => {
		// Two checks can land in the same millisecond; a zero-width interval would
		// produce an infinite slope and NaN control points.
		const segs = monotoneSegments([
			{ x: 0, y: 10 },
			{ x: 0, y: 90 },
			{ x: 10, y: 20 }
		]);
		for (const s of segs) {
			for (const v of [s.c1x, s.c1y, s.c2x, s.c2y]) expect(Number.isFinite(v)).toBe(true);
		}
	});

	it('returns nothing for fewer than two usable points', () => {
		expect(monotoneSegments([])).toEqual([]);
		expect(monotoneSegments([{ x: 0, y: 1 }])).toEqual([]);
	});
});

describe('path strings', () => {
	it('forward starts with a move and then cubics only', () => {
		const d = forwardPath(monotoneSegments(pts(10, 20, 15)));
		expect(d.startsWith('M')).toBe(true);
		expect(d.match(/C/g)).toHaveLength(2);
		expect(d).not.toContain('L');
	});

	it('reverse retraces the same curve, controls swapped', () => {
		// Not a re-interpolation of reversed input: that is subtly different geometry
		// and the two edges of a band would fail to meet.
		const segs = monotoneSegments(pts(10, 20, 15));
		const rev = reversePath(segs);
		const last = segs[segs.length - 1];
		expect(rev.trimStart().startsWith(`C${last.c2x.toFixed(1)}`)).toBe(true);
		expect(rev.trimEnd().endsWith(`${segs[0].x0.toFixed(1)} ${segs[0].y0.toFixed(1)}`)).toBe(true);
	});

	it('is empty for an empty input', () => {
		expect(forwardPath([])).toBe('');
		expect(reversePath([])).toBe('');
	});
});

describe('stacked outlines never cross', () => {
	it('keeps every layer at or below the one above it, between samples too', () => {
		// Bands are built between adjacent cumulative outlines, so if two smoothed
		// outlines crossed, one phase would visibly bleed through another.
		// (SVG y grows downward, so "above" is a smaller y.)
		const dns = [12, 14, 11, 40, 13, 12];
		const connect = [30, 26, 60, 55, 24, 22];
		const tls = [18, 40, 22, 20, 30, 19];
		const transfer = [90, 120, 70, 300, 85, 95];
		const cums = [0, 1, 2, 3, 4].map((k) =>
			dns.map((_, i) => {
				const stack = [dns[i], connect[i], tls[i], transfer[i]].slice(0, k);
				return { x: i * 10, y: 400 - stack.reduce((a, b) => a + b, 0) };
			})
		);
		const levels = cums.map((c) => monotoneSegments(c));
		for (let k = 0; k < levels.length - 1; k++) {
			for (let si = 0; si < levels[k].length; si++) {
				const lower = ys(levels[k][si]);
				const upper = ys(levels[k + 1][si]);
				for (let i = 0; i < lower.length; i++) {
					expect(upper[i]).toBeLessThanOrEqual(lower[i] + 1e-9);
				}
			}
		}
	});
});
