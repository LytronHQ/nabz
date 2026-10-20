import { test, expect } from '@playwright/test';

// The rest of the suite blocks service workers (playwright.config.ts). Full
// Chromium, not the headless shell, which crashes closing a traced context that
// has a live worker.
test.use({ serviceWorkers: 'allow', channel: 'chromium' });

// An installed copy had no service worker and no way to learn about a new build;
// with no reload button, it ran the old one until closed (#493).

test('a service worker controls the page and caches only the immutable build', async ({ page }) => {
	await page.goto('/');
	await page.evaluate(() => navigator.serviceWorker.ready);
	await page.reload();
	expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
	const cached = await page.evaluate(async () => {
		const out: string[] = [];
		for (const k of await caches.keys()) {
			for (const r of await (await caches.open(k)).keys()) out.push(new URL(r.url).pathname);
		}
		return out;
	});
	expect(cached.length).toBeGreaterThan(0);
	// Pages and data are never answered from cache.
	expect(cached.every((p) => p.startsWith('/_app/'))).toBe(true);
});

test('an open page offers a reload once a new build is deployed', async ({ page }) => {
	await page.clock.install();
	await page.goto('/');
	await expect(page.getByText('A new version of nabz is ready.')).toHaveCount(0);
	// What the next deploy's poll would see: a different build name.
	await page.route('**/_app/version.json', (route) =>
		route.fulfill({ json: { version: 'a-newer-build' } })
	);
	await page.clock.runFor(61_000);
	const banner = page.getByRole('status').filter({ hasText: 'A new version of nabz is ready.' });
	await expect(banner).toBeVisible();
	await expect(banner.getByRole('button', { name: 'Reload' })).toBeVisible();
});
