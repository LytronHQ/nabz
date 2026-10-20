// Zoom transform that fits a force layout inside its canvas. The monitor map and
// the dependency graph had none: forceCenter only centres the mass, so on a
// phone-width canvas nodes and their labels ran off both edges and some were
// never on screen at all.

export type FitPoint = {
	x: number;
	y: number;
	r: number;
	/** Half the label width, when a label is wider than the node. */
	hw?: number;
	/** How far a label reaches above / below the node centre. */
	above?: number;
	below?: number;
};

export type FitOptions = {
	pad?: number;
	/** Reserved strip at the top (the legend/controls overlay). */
	top?: number;
	minK?: number;
	maxK?: number;
};

export function fitTransform(
	pts: FitPoint[],
	width: number,
	height: number,
	{ pad = 20, top = 0, minK = 0.25, maxK = 1 }: FitOptions = {}
): { x: number; y: number; k: number } {
	if (pts.length === 0) return { x: 0, y: 0, k: 1 };
	let x0 = Infinity,
		x1 = -Infinity,
		y0 = Infinity,
		y1 = -Infinity;
	for (const p of pts) {
		const half = Math.max(p.r, p.hw ?? 0);
		x0 = Math.min(x0, p.x - half);
		x1 = Math.max(x1, p.x + half);
		y0 = Math.min(y0, p.y - Math.max(p.r, p.above ?? 0));
		y1 = Math.max(y1, p.y + Math.max(p.r, p.below ?? 0));
	}
	const availW = Math.max(1, width - 2 * pad);
	const availH = Math.max(1, height - top - 2 * pad);
	const k = Math.min(
		maxK,
		Math.max(minK, Math.min(availW / (x1 - x0 || 1), availH / (y1 - y0 || 1)))
	);
	return {
		k,
		x: width / 2 - (k * (x0 + x1)) / 2,
		y: top + pad + availH / 2 - (k * (y0 + y1)) / 2
	};
}
