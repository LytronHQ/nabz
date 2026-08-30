/** Monotone cubic interpolation (Fritsch–Carlson) for the response-time chart.
 *
 *  Deliberately NOT Catmull-Rom or a plain cubic spline. Those overshoot: between
 *  two samples the curve can rise above both or dip below both, inventing values
 *  that were never measured. On this chart that is not a cosmetic matter — there
 *  is a latency threshold line, and a curve that dips under it where the data
 *  never did would be drawing a breach that did not happen.
 *
 *  Fritsch–Carlson limits each tangent so the interpolant is monotone on every
 *  interval: it passes through every sample and stays within the pair it connects.
 *  At a local peak or trough the tangent is forced to zero, so the curve turns at
 *  the sample rather than beyond it.
 */

export type Point = { x: number; y: number };

/** One cubic Bézier: from (x0,y0) to (x1,y1) via two control points. */
export type Segment = {
	x0: number;
	y0: number;
	c1x: number;
	c1y: number;
	c2x: number;
	c2y: number;
	x1: number;
	y1: number;
};

/** Cubic segments through `points`, which must be ordered by increasing x.
 *
 *  Points sharing an x are dropped: a zero-width interval has an infinite slope,
 *  and two checks can land in the same millisecond. */
export function monotoneSegments(points: readonly Point[]): Segment[] {
	const p = points.filter(
		(pt, i) => i === 0 || pt.x > points[i - 1].x
	);
	const n = p.length;
	if (n < 2) return [];

	// Secant slope of each interval.
	const delta: number[] = [];
	for (let i = 0; i < n - 1; i++) delta.push((p[i + 1].y - p[i].y) / (p[i + 1].x - p[i].x));

	// Tangent at each point: the average of the neighbouring secants, except at a
	// turning point, where opposite-signed secants force it flat — this is what
	// stops the curve sailing past a peak.
	const m: number[] = new Array(n);
	m[0] = delta[0];
	m[n - 1] = delta[n - 2];
	for (let i = 1; i < n - 1; i++) {
		m[i] = delta[i - 1] * delta[i] <= 0 ? 0 : (delta[i - 1] + delta[i]) / 2;
	}

	// Fritsch–Carlson limiter. Keeping (m_i, m_i+1) inside a circle of radius 3
	// around the secant is the condition for monotonicity on that interval; a flat
	// interval pins both tangents to zero so the curve cannot bulge across it.
	for (let i = 0; i < n - 1; i++) {
		if (delta[i] === 0) {
			m[i] = 0;
			m[i + 1] = 0;
			continue;
		}
		const a = m[i] / delta[i];
		const b = m[i + 1] / delta[i];
		const s = a * a + b * b;
		if (s > 9) {
			const t = 3 / Math.sqrt(s);
			m[i] = t * a * delta[i];
			m[i + 1] = t * b * delta[i];
		}
	}

	// Hermite -> Bézier: control points one third of the interval along each
	// tangent, which is the standard equivalence and keeps the curve through the
	// samples exactly.
	const out: Segment[] = [];
	for (let i = 0; i < n - 1; i++) {
		const dx = p[i + 1].x - p[i].x;
		out.push({
			x0: p[i].x,
			y0: p[i].y,
			c1x: p[i].x + dx / 3,
			c1y: p[i].y + (m[i] * dx) / 3,
			c2x: p[i + 1].x - dx / 3,
			c2y: p[i + 1].y - (m[i + 1] * dx) / 3,
			x1: p[i + 1].x,
			y1: p[i + 1].y
		});
	}
	return out;
}

const f = (v: number) => v.toFixed(1);

/** `M … C …` for the segments, left to right. */
export function forwardPath(segs: readonly Segment[]): string {
	if (!segs.length) return '';
	let d = `M${f(segs[0].x0)} ${f(segs[0].y0)}`;
	for (const s of segs) d += ` C${f(s.c1x)} ${f(s.c1y)} ${f(s.c2x)} ${f(s.c2y)} ${f(s.x1)} ${f(s.y1)}`;
	return d;
}

/** The same curve traversed right to left, as `C` commands only — for closing a
 *  filled band back along its lower edge.
 *
 *  The control points swap: a cubic reversed is the same curve with its two
 *  controls in the other order. Re-running the interpolation on reversed input
 *  would be subtly different geometry, and the band's two edges would not meet. */
export function reversePath(segs: readonly Segment[]): string {
	let d = '';
	for (let i = segs.length - 1; i >= 0; i--) {
		const s = segs[i];
		d += ` C${f(s.c2x)} ${f(s.c2y)} ${f(s.c1x)} ${f(s.c1y)} ${f(s.x0)} ${f(s.y0)}`;
	}
	return d;
}
