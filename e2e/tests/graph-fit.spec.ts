import { test, expect, type Page } from '@playwright/test';
import { signIn } from './helpers';

// On a phone the monitor map's search box covered its legend, and the force
// layouts (map and dependency graph) ran off the canvas: forceCenter only
// centres the mass, nothing fitted the view, so nodes sat outside the visible
// area. Each graph now fits itself while it settles.

test.use({ viewport: { width: 390, height: 844 } });

type Box = { x: number; y: number; width: number; height: number };
const overlap = (a: Box, b: Box) =>
	a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

async function nodesOutside(page: Page) {
	const svg = page.locator('svg[role=img]');
	await expect(svg.locator('g.node').first()).toBeVisible();
	// Let the layout settle; the view refits on every tick until then.
	await page.waitForTimeout(5_000);
	return svg.evaluate((el) => {
		const b = el.getBoundingClientRect();
		const gs = [...el.querySelectorAll('g.node')];
		const out = gs.filter((g) => {
			const r = g.getBoundingClientRect();
			return (
				r.left < b.left - 1 || r.right > b.right + 1 || r.top < b.top - 1 || r.bottom > b.bottom + 1
			);
		});
		return { total: gs.length, outside: out.length };
	});
}

test('monitor map: legend and controls do not overlap, every node is on the canvas', async ({
	page
}) => {
	await signIn(page);
	await page.goto('/monitors/map');
	const legend = await page.locator('.legend').boundingBox();
	const search = await page.getByRole('searchbox', { name: 'Search monitors' }).boundingBox();
	expect(legend && search).toBeTruthy();
	expect(overlap(legend!, search!), 'search box over the legend').toBe(false);
	const r = await nodesOutside(page);
	expect(r.total).toBeGreaterThan(0);
	expect(r.outside, `${r.outside} of ${r.total} nodes off the canvas`).toBe(0);
});

test('dependency graph: every node is on the canvas', async ({ page }) => {
	await signIn(page);
	await page.goto('/monitors/dependencies');
	const r = await nodesOutside(page);
	expect(r.total).toBeGreaterThan(0);
	expect(r.outside, `${r.outside} of ${r.total} nodes off the canvas`).toBe(0);
});
