import { test, expect } from '@playwright/test';

// The pages a visitor sees before signing up, and the landing page's main call
// to action. "Try it free" needs a worker in zone `free`; production had none, so
// the try page said "Checking…" forever (#522).

test('try it free: a URL from the landing page comes back Up', async ({ page }) => {
	await page.goto('/');
	await page.getByLabel('URL to monitor').fill('http://fixture:8080/status/200');
	await page.getByRole('button', { name: 'Try it free' }).click();
	await expect(page).toHaveURL(/\/try\/[a-z0-9]+/);
	// The page polls every 8s; the free worker checks a new row on its next reconcile.
	await expect(page.getByText('Up', { exact: true }).first()).toBeVisible({
		timeout: 60_000
	});
	await expect(page.getByText('Checking…')).toHaveCount(0);
});

for (const path of [
	'/',
	'/signin',
	'/signup',
	'/reset-password',
	'/changelog',
	'/privacy',
	'/terms'
]) {
	test(`public page ${path} renders without errors`, async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
		const res = await page.goto(path);
		expect(res?.status(), `${path} status`).toBeLessThan(400);
		await page.waitForLoadState('networkidle');
		expect(errors, `${path} errors`).toEqual([]);
	});
}
