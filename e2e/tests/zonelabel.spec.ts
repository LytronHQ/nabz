import { test, expect } from '@playwright/test';
import { signIn } from './helpers';

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

// The monitor page used to skip the zones table: its By zone cards, consensus
// note and Region select showed codes while the form said "Europe"/"Asia" for
// the same zones (#558).
test('the monitor page names its zones the way the form does', async ({ page }) => {
	await signIn(page);
	const name = `e2e-zonelabel-${Date.now().toString(36)}`;
	await page.goto('/monitors/new');
	await page.getByLabel('Name', { exact: true }).fill(name);
	await page.getByLabel('URL', { exact: true }).fill('http://fixture:8080/status/200');
	await page.getByLabel('Interval (seconds)').fill('30');
	await page.getByLabel('E2E Region').check();
	await page.getByRole('button', { name: 'Add monitor' }).click();
	await expect(page).toHaveURL(/\/monitors$/);
	const href = await page
		.getByRole('row')
		.filter({ hasText: name })
		.getByRole('link')
		.first()
		.getAttribute('href');
	expect(href).toMatch(/^\/monitors\/[a-z0-9]+$/);
	await page.goto(href!);

	// An assigned zone has a card before its first check; wait for the check, so
	// the Region select has the zone too.
	const card = page.locator('.zone-cards .zc').first();
	await expect(async () => {
		await page.reload();
		await expect(card.locator('.lat')).toContainText('ms', { timeout: 2_000 });
	}).toPass({ timeout: 90_000 });
	await expect(card.locator('b')).toHaveText('E2E Region');
	await expect(page.getByText('zones: E2E Region')).toBeVisible();
	await expect(
		page.getByLabel('Region', { exact: true }).locator('option', { hasText: 'E2E Region' })
	).toHaveCount(1);

	// The Recent checks log named zones by code after the rest of the page moved
	// to labels, and every past row's dot pulsed like a live status (#562).
	const log = page.locator('.card', { has: page.getByRole('heading', { name: 'Recent checks' }) });
	const row = log.locator('tbody tr').first();
	await expect(row.locator('.zone-tag')).toHaveText('E2E Region');
	const animation = (sel: string) =>
		page
			.locator(sel)
			.first()
			.evaluate((el) => getComputedStyle(el).animationName);
	expect(await animation('.zone-cards .zc .pill .glyph')).toBe('livepulse');
	expect(await log.locator('tbody tr .pill .glyph').count()).toBeGreaterThan(0);
	const logAnimations = await log
		.locator('tbody tr .pill .glyph')
		.evaluateAll((els) => els.map((el) => getComputedStyle(el).animationName));
	expect(logAnimations.every((n) => n === 'none')).toBe(true);

	await page.goto('/monitors');
	page.once('dialog', (d) => d.accept());
	await page
		.getByRole('row')
		.filter({ hasText: name })
		.getByRole('button', { name: 'Delete' })
		.click();
	await expect(page.getByRole('row').filter({ hasText: name })).toHaveCount(0);
});

// The incident cause is stored as the evaluator wrote it, with zone codes
// ("down in e2e"); the dashboard, the incidents list and the incident page
// showed it as is, beside a Zones card saying "E2E Region" (#560).
test('incident causes name zones the way the rest of the app does', async ({ page }) => {
	// Opening an incident takes consecutive failed checks.
	test.setTimeout(240_000);
	await signIn(page);
	const name = `e2e-zonecause-${Date.now().toString(36)}`;
	await page.goto('/monitors/new');
	await page.getByLabel('Name', { exact: true }).fill(name);
	await page.getByLabel('URL', { exact: true }).fill('http://fixture:8080/status/500');
	await page.getByLabel('Interval (seconds)').fill('30');
	await page.getByLabel('E2E Region').check();
	await page.getByRole('button', { name: 'Add monitor' }).click();
	await expect(page).toHaveURL(/\/monitors$/);

	const row = page.locator('.inc').filter({ hasText: name });
	await expect(async () => {
		await page.goto('/incidents');
		await expect(row).toBeVisible({ timeout: 2_000 });
	}).toPass({ timeout: 120_000 });
	await expect(row).toContainText('down in E2E Region');

	await page.goto('/dashboard');
	await expect(page.locator('.inc').filter({ hasText: name })).toContainText('down in E2E Region');

	await page.goto('/monitors');
	page.once('dialog', (d) => d.accept());
	await page
		.getByRole('row')
		.filter({ hasText: name })
		.getByRole('button', { name: 'Delete' })
		.click();
	await expect(page.getByRole('row').filter({ hasText: name })).toHaveCount(0);
});
