import { test, expect, type Page } from '@playwright/test';

// Public status pages (#679), on a fresh Free account: a page shows only the
// monitors chosen for it, never a monitor's address, carries the "powered by"
// footer on Free, and an unknown address is a 404 for a signed-out visitor.

const RUN = Date.now().toString(36);
const EMAIL = `e2e-sp-${RUN}@example.com`;
const PASS = `sp-pass-${RUN}`;
const SLUG = `e2e-${RUN}`;
const SHOWN = `sp-shown-${RUN}`;
const HIDDEN = `sp-hidden-${RUN}`;
const SECRET_PATH = `/status/200?secret=${RUN}`;

async function signInAs(page: Page, email: string, password: string) {
	await page.goto('/signin');
	await page.getByLabel('Email', { exact: true }).fill(email);
	await page.getByLabel('Password').fill(password);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL(/\/dashboard|\/change-password/);
}

// fetch inside the page, not page.request: see the 2026-11-03 note in CLAUDE.md.
async function addMonitor(page: Page, name: string) {
	return page.evaluate(
		async ({ name, target }) => {
			const fd = new FormData();
			fd.set('name', name);
			fd.set('type', 'website');
			fd.set('target', target);
			fd.set('interval', '300');
			fd.set('enabled', 'true');
			return (await fetch('/api/monitors', { method: 'POST', body: fd })).status;
		},
		{ name, target: `http://fixture:8080${SECRET_PATH}` }
	);
}

test.describe.serial('a public status page', () => {
	test('a new account makes a page with one of its two monitors', async ({ page }) => {
		await page.goto('/signup');
		await page.getByLabel('Email').fill(EMAIL);
		await page.getByLabel('Password', { exact: true }).fill(PASS);
		await page.getByLabel('Confirm password').fill(PASS);
		await page.getByRole('button', { name: 'Sign up' }).click();
		await expect(page).not.toHaveURL(/\/signup$/, { timeout: 15_000 });

		await signInAs(page, EMAIL, PASS);
		expect(await addMonitor(page, SHOWN)).toBe(201);
		expect(await addMonitor(page, HIDDEN)).toBe(201);

		await page.getByRole('link', { name: 'Status pages' }).click();
		await expect(page).toHaveURL(/\/status-pages$/);
		await page.getByLabel('Title').fill(`Acme ${RUN}`);
		await page.getByLabel('Address').fill(SLUG);
		await page.getByRole('checkbox', { name: SHOWN }).check();
		await page.getByRole('button', { name: 'Create page' }).click();
		await expect(page.getByText(`Your page is live at /s/${SLUG}.`)).toBeVisible();
		await expect(page.getByRole('link', { name: new RegExp(`/s/${SLUG}$`) })).toBeVisible();
	});

	test('Free refuses a second page', async ({ page }) => {
		await signInAs(page, EMAIL, PASS);
		await page.goto('/status-pages');
		await expect(page.getByText(/includes 1 status page, and you have reached that/)).toBeVisible();
		await expect(page.getByRole('button', { name: 'Create page' })).toHaveCount(0);
	});

	test('a signed-out visitor sees only the chosen monitor, and no address', async ({ browser }) => {
		const ctx = await browser.newContext();
		const page = await ctx.newPage();
		const res = await page.goto(`/s/${SLUG}`);
		expect(res?.status()).toBe(200);
		await expect(page.getByRole('heading', { name: `Acme ${RUN}`, level: 1 })).toBeVisible();
		await expect(page.getByText(SHOWN)).toBeVisible();
		await expect(page.getByText(HIDDEN)).toHaveCount(0);
		const html = await page.content();
		expect(html).not.toContain(`secret=${RUN}`);
		expect(html).not.toContain('fixture:8080');
		// No app shell for anyone, and the Free footer.
		await expect(page.getByRole('navigation')).toHaveCount(0);
		await expect(page.getByRole('link', { name: 'nabz' })).toHaveAttribute(
			'href',
			'https://nabz.sh/'
		);
		await ctx.close();
	});

	test('the owner sees the same page, without the app shell', async ({ page }) => {
		await signInAs(page, EMAIL, PASS);
		await page.goto(`/s/${SLUG}`);
		await expect(page.getByText(SHOWN)).toBeVisible();
		await expect(page.getByRole('link', { name: 'Dashboard' })).toHaveCount(0);
	});

	test('an unknown address is a 404', async ({ browser }) => {
		const ctx = await browser.newContext();
		const page = await ctx.newPage();
		const res = await page.goto(`/s/no-such-page-${RUN}`);
		expect(res?.status()).toBe(404);
		await ctx.close();
	});

	test('deleting a monitor the page shows leaves the page working', async ({ page, browser }) => {
		await signInAs(page, EMAIL, PASS);
		const status = await page.evaluate(async (name) => {
			const list = await (await fetch(`/api/monitors?q=${encodeURIComponent(name)}`)).json();
			const id = list.items?.[0]?.id;
			return id ? (await fetch(`/api/monitors/${id}`, { method: 'DELETE' })).status : 0;
		}, SHOWN);
		expect(status).toBe(204);
		const ctx = await browser.newContext();
		const visitor = await ctx.newPage();
		const res = await visitor.goto(`/s/${SLUG}`);
		expect(res?.status()).toBe(200);
		await expect(visitor.getByText(SHOWN)).toHaveCount(0);
		await ctx.close();
	});

	test('the owner deletes the page and its address stops working', async ({ page }) => {
		await signInAs(page, EMAIL, PASS);
		await page.goto('/status-pages');
		await page.getByRole('link', { name: 'Edit' }).click();
		page.on('dialog', (d) => d.accept());
		await page.getByRole('button', { name: 'Delete page' }).click();
		await expect(page).toHaveURL(/\/status-pages$/);
		await expect(page.getByText('No status pages yet.')).toBeVisible();
		const res = await page.goto(`/s/${SLUG}`);
		expect(res?.status()).toBe(404);
	});
});
