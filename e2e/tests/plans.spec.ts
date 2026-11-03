import { test, expect, type Page } from '@playwright/test';

// Plan limits (#678), on a FRESH account: the shared e2e users are on Pro (seed.ts),
// so the Free limits are seen only on an account made here. Free refuses the 11th
// monitor and a 30 s interval; once an admin sets the account to Pro, both work.

const RUN = Date.now().toString(36);
const EMAIL = `e2e-plan-${RUN}@example.com`;
const PASS = `plan-pass-${RUN}`;
const ADMIN = process.env.E2E_ADMIN_EMAIL || 'staff@e2e.local';
const ADMIN_PASS = process.env.E2E_ADMIN_PASSWORD || 'e2e-staff-pass';
const FIXTURE = 'http://fixture:8080';

async function signInAs(page: Page, email: string, password: string) {
	await page.goto('/signin');
	await page.getByLabel('Email', { exact: true }).fill(email);
	await page.getByLabel('Password').fill(password);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL(/\/dashboard|\/change-password/);
}

async function fillMonitor(page: Page, name: string, interval: string) {
	await page.goto('/monitors/new');
	await page.getByLabel('Name', { exact: true }).fill(name);
	await page.getByLabel('URL', { exact: true }).fill(`${FIXTURE}/status/200`);
	await page.getByLabel('Interval (seconds)').fill(interval);
	await page.getByRole('button', { name: 'Add monitor' }).click();
}

// Through the web API, with fetch inside the page. Not page.request: the e2e web
// sets pb_auth as Secure, which Chromium sends to http://127.0.0.1 (a trustworthy
// origin) but Playwright's request client does not; the API then sees no user, and
// its response clears the session cookie for the whole context.
// The availability table's period column on a monitor's page (#703). The page's
// path is kept for the Pro step: by then the list has a second page.
let monitorPath = '';
async function openMonitor(page: Page, name: string) {
	if (monitorPath) {
		await page.goto(monitorPath);
	} else {
		await page.goto('/monitors');
		await page.getByRole('link', { name: new RegExp(`^${name} `) }).click();
		await expect(page).toHaveURL(/\/monitors\/[a-z0-9]+$/);
		monitorPath = new URL(page.url()).pathname;
	}
	await expect(page.getByRole('heading', { name: 'Availability' })).toBeVisible();
}
const periods = (page: Page) =>
	page
		.locator('.card', { has: page.getByRole('heading', { name: 'Availability' }) })
		.locator('tbody tr td:first-child')
		.allInnerTexts();

async function addByApi(page: Page, name: string) {
	return page.evaluate(
		async ({ name, target }) => {
			const fd = new FormData();
			fd.set('name', name);
			fd.set('type', 'website');
			fd.set('target', target);
			fd.set('interval', '300');
			fd.set('enabled', 'false');
			return (await fetch('/api/monitors', { method: 'POST', body: fd })).status;
		},
		{ name, target: `${FIXTURE}/status/200` }
	);
}

test.describe.serial('Free and Pro limits on a new account', () => {
	test('sign up a fresh account', async ({ page }) => {
		await page.goto('/signup');
		await page.getByLabel('Email').fill(EMAIL);
		await page.getByLabel('Password', { exact: true }).fill(PASS);
		await page.getByLabel('Confirm password').fill(PASS);
		await page.getByRole('button', { name: 'Sign up' }).click();
		await expect(page).not.toHaveURL(/\/signup$/, { timeout: 15_000 });
	});

	test('Free refuses a 30 second interval, inline, and starts new monitors at 5 minutes', async ({
		page
	}) => {
		await signInAs(page, EMAIL, PASS);
		await page.goto('/monitors/new');
		await expect(page.getByLabel('Interval (seconds)')).toHaveValue('300');
		await fillMonitor(page, `plan-fast-${RUN}`, '30');
		await expect(page).toHaveURL(/\/monitors\/new$/);
		await expect(page.getByText(/checked every 5 minutes at the fastest/)).toBeVisible();
	});

	test('Free refuses the 11th monitor', async ({ page }) => {
		await signInAs(page, EMAIL, PASS);
		for (let i = 1; i <= 10; i++) expect(await addByApi(page, `plan-${RUN}-${i}`)).toBe(201);

		await page.goto('/account');
		await expect(page.locator('#plan')).toContainText('Free');
		await expect(page.locator('#plan')).toContainText('10 of 10');

		// The form says so before anything is typed, and the save is refused.
		await page.goto('/monitors/new');
		await expect(page.getByRole('alert').filter({ hasText: 'includes 10 monitors' })).toBeVisible();
		await fillMonitor(page, `plan-${RUN}-11`, '300');
		await expect(
			page.getByText(/includes 10 monitors, and you have reached that/).last()
		).toBeVisible();
		expect(await addByApi(page, `plan-${RUN}-11b`)).toBe(402);
	});

	test('Free shows 30 days of history (#703)', async ({ page }) => {
		await signInAs(page, EMAIL, PASS);
		await openMonitor(page, `plan-${RUN}-1`);
		expect(await periods(page)).toEqual(['Today', 'Last 7 days', 'Last 30 days']);
		await expect(page.getByText(/Free plan shows the last 30 days of history/)).toBeVisible();

		// The date picker starts at the window, and an older From is refused.
		const min = await page.getByLabel('From').getAttribute('min');
		expect(min).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		const id = page.url().split('/').pop();
		const status = await page.evaluate(
			async (id) => (await fetch(`/api/monitors/${id}/availability?from=2020-01-01`)).status,
			id
		);
		expect(status).toBe(400);

		await page.goto('/incidents');
		await expect(page.getByText(/Free plan shows the last 30 days of history/)).toBeVisible();
		await page.goto('/account');
		await expect(page.locator('#plan')).toContainText('Last 30 days');
	});

	test('an admin sets the account to Pro', async ({ page }) => {
		await signInAs(page, ADMIN, ADMIN_PASS);
		await page.goto('/admin/plans');
		await page.getByLabel('Account email or id').fill(EMAIL);
		await page.getByLabel('Plan').selectOption('pro');
		await page.getByRole('button', { name: 'Save plan' }).click();
		await expect(page.getByRole('status')).toContainText(`${EMAIL} is now on Pro.`);
		await expect(page.getByRole('row').filter({ hasText: EMAIL })).toContainText('Pro');
	});

	test('Pro allows the 11th monitor at 30 seconds', async ({ page }) => {
		await signInAs(page, EMAIL, PASS);
		await fillMonitor(page, `plan-${RUN}-pro`, '30');
		await expect(page).toHaveURL(/\/monitors$/);
		await expect(page.getByRole('row').filter({ hasText: `plan-${RUN}-pro` })).toBeVisible();

		await page.goto('/account');
		await expect(page.locator('#plan')).toContainText('Pro');
		await expect(page.locator('#plan')).toContainText('11 of 100');
		await expect(page.locator('#plan')).toContainText('Last 1 year');
	});

	test('Pro shows a year of history (#703)', async ({ page }) => {
		await signInAs(page, EMAIL, PASS);
		await openMonitor(page, `plan-${RUN}-1`);
		expect(await periods(page)).toEqual(['Today', 'Last 7 days', 'Last 30 days', 'Last 365 days']);
		await expect(page.getByText(/plan shows the last/)).toHaveCount(1);
		await expect(page.getByText(/Older history is kept/)).toHaveCount(0);
	});

	test('a signed-in non-admin gets a 404 from /admin/plans', async ({ page }) => {
		await signInAs(page, EMAIL, PASS);
		const res = await page.goto('/admin/plans');
		expect(res?.status()).toBe(404);
	});
});
