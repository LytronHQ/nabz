import { test, expect } from '@playwright/test';

const WEB = process.env.E2E_WEB_URL ?? 'http://127.0.0.1:4390';

// Zone display names are decoupled from zone codes (#311): the code is the queue
// key stamped into checks.zone, the display name is presentation. setup.sh seeds
// the e2e zone with code "e2e" and display name "E2E Region" precisely so the two
// cannot be confused for each other here.
test('the dashboard shows a zone display name, not its code', async ({ page }) => {
	await page.goto(`${WEB}/signin`);
	await page.fill('input[name="email"]', 'user@e2e.local');
	await page.fill('input[name="password"]', 'e2e-user-pass');
	await page.click('button[type="submit"]');
	await page.waitForURL(/dashboard/);

	const zonesCard = page.locator('.card', { hasText: 'Zones' }).first();
	await expect(zonesCard).toContainText('E2E Region');
	// The bare code must not be what a user reads.
	await expect(zonesCard.locator('b', { hasText: /^e2e$/ })).toHaveCount(0);
});
