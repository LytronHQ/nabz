import { test, expect } from 'vitest';
import { fitTransform, type FitPoint } from './fit-view';

const apply = (t: { x: number; y: number; k: number }, x: number, y: number) => [
	t.x + t.k * x,
	t.y + t.k * y
];

test('a layout wider than a phone canvas is scaled down so every node and label is inside', () => {
	// What the dependency graph produced at 390px: nodes from -200 to 700 wide.
	const pts: FitPoint[] = [
		{ x: -200, y: 100, r: 11, hw: 60 },
		{ x: 700, y: 400, r: 11, hw: 60 },
		{ x: 250, y: 250, r: 11, hw: 60 }
	];
	const t = fitTransform(pts, 360, 560, { pad: 16, top: 48 });
	for (const p of pts) {
		const [l] = apply(t, p.x - p.hw!, p.y);
		const [r] = apply(t, p.x + p.hw!, p.y);
		const [, top] = apply(t, p.x, p.y - p.r);
		expect(l).toBeGreaterThanOrEqual(16 - 1e-9);
		expect(r).toBeLessThanOrEqual(360 - 16 + 1e-9);
		expect(top).toBeGreaterThanOrEqual(48 + 16 - 1e-9);
	}
	expect(t.k).toBeLessThan(1);
});

test('a small layout is centred, never zoomed in past 1', () => {
	const t = fitTransform([{ x: 0, y: 0, r: 10 }], 900, 560);
	expect(t.k).toBe(1);
	const [x, y] = apply(t, 0, 0);
	expect(Math.abs(x - 450)).toBeLessThan(1);
	expect(y).toBeGreaterThan(200);
	expect(y).toBeLessThan(360);
});

test('never zooms out past minK; an empty layout is the identity', () => {
	const far: FitPoint[] = [
		{ x: -1e5, y: 0, r: 5 },
		{ x: 1e5, y: 0, r: 5 }
	];
	expect(fitTransform(far, 360, 560, { minK: 0.25 }).k).toBe(0.25);
	expect(fitTransform([], 360, 560)).toEqual({ x: 0, y: 0, k: 1 });
});
