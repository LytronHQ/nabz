import { test, expect, type Page } from '@playwright/test';
import { signIn } from './helpers';

// The monitor features beyond create/delete, each driven the way a user does:
// tags and search, pause/resume, a maintenance window that survives a save, and
// a heartbeat monitor whose check-in URL actually turns it Up.

const RUN = Date.now().toString(36);
const FIXTURE = 'http://fixture:8080';

async function newWebsite(page: Page, name: string, extra?: (p: Page) => Promise<void>) {
	await page.goto('/monitors/new');
	await page.getByLabel('Name', { exact: true }).fill(name);
	await page.getByLabel('URL', { exact: true }).fill(`${FIXTURE}/status/200`);
	await page.getByLabel('Interval (seconds)').fill('30');
	if (extra) await extra(page);
	await page.getByRole('button', { name: 'Add monitor' }).click();
	await expect(page).toHaveURL(/\/monitors$/);
	await expect(page.getByRole('row').filter({ hasText: name })).toBeVisible();
}

async function remove(page: Page, name: string) {
	await page.goto('/monitors');
	page.once('dialog', (d) => d.accept());
	await page
		.getByRole('row')
		.filter({ hasText: name })
		.getByRole('button', { name: 'Delete' })
		.click();
	await expect(page.getByRole('row').filter({ hasText: name })).toHaveCount(0);
}

test('tags: added in the form, shown in the list, findable by search', async ({ page }) => {
	await signIn(page);
	const name = `e2e-tagged-${RUN}`;
	const tag = `tag${RUN}`;
	await newWebsite(page, name, async (p) => {
		const input = p.getByPlaceholder('prod, api, eu…');
		await input.fill(tag);
		await input.press('Enter');
		await expect(p.getByRole('button', { name: `Remove ${tag}` })).toBeVisible();
	});
	const row = page.getByRole('row').filter({ hasText: name });
	await expect(row).toContainText(tag);
	await page.getByRole('searchbox').fill(tag);
	await expect(page.getByRole('row').filter({ hasText: name })).toBeVisible();
	await page.getByRole('searchbox').fill(`no-such-${RUN}`);
	await expect(page.getByRole('row').filter({ hasText: name })).toHaveCount(0);
	await page.getByRole('searchbox').fill('');
	await remove(page, name);
});

test('pause and resume from the list', async ({ page }) => {
	await signIn(page);
	const name = `e2e-pause-${RUN}`;
	await newWebsite(page, name);
	const row = () => page.getByRole('row').filter({ hasText: name });
	await row().getByRole('button', { name: 'Pause' }).click();
	await expect(row().getByRole('button', { name: /resume/i })).toBeVisible();
	await page.reload();
	await expect(row().getByRole('button', { name: /resume/i })).toBeVisible();
	await row()
		.getByRole('button', { name: /resume/i })
		.click();
	await expect(row().getByRole('button', { name: 'Pause' })).toBeVisible();
	await remove(page, name);
});

test('a maintenance window is saved and shown again on edit', async ({ page }) => {
	await signIn(page);
	const name = `e2e-maint-${RUN}`;
	await newWebsite(page, name, async (p) => {
		await p.getByText('Maintenance windows').click();
		await p.getByRole('button', { name: '+ Add window' }).click();
		const inputs = p.locator('input[type="datetime-local"]');
		await expect(inputs).toHaveCount(2);
		await inputs.nth(0).fill('2030-01-01T01:00');
		await inputs.nth(1).fill('2030-01-01T03:00');
	});
	await page
		.getByRole('row')
		.filter({ hasText: name })
		.getByRole('button', { name: 'Edit' })
		.click();
	// The read-only type reads like the select on the new form did.
	await expect(page.getByLabel('Type', { exact: true })).toHaveValue('Website');
	await page.getByText('Maintenance windows').click();
	const inputs = page.locator('input[type="datetime-local"]');
	await expect(inputs).toHaveCount(2);
	await expect(inputs.nth(0)).toHaveValue('2030-01-01T01:00');
	await expect(inputs.nth(1)).toHaveValue('2030-01-01T03:00');
	await remove(page, name);
});

test('heartbeat: the check-in URL on its page turns it Up', async ({ page, request }) => {
	await signIn(page);
	const name = `e2e-heartbeat-${RUN}`;
	await page.goto('/monitors/new');
	await page.getByLabel('Name', { exact: true }).fill(name);
	await page.locator('select.form-input').first().selectOption('heartbeat');
	await page.getByLabel('Interval (seconds)').fill('60');
	await page.getByRole('button', { name: 'Add monitor' }).click();
	await expect(page).toHaveURL(/\/monitors$/);
	await page.getByRole('row').filter({ hasText: name }).getByRole('link').first().click();
	await expect(page.getByText('Check-in URL')).toBeVisible();
	const url = await page.locator('code').filter({ hasText: '/ping/' }).first().innerText();
	const token = url.match(/\/ping\/([^\s]+)/)?.[1];
	expect(token, `no token in "${url}"`).toBeTruthy();
	const res = await request.get(`/ping/${token}`);
	expect(res.status(), 'check-in').toBeLessThan(300);
	await expect(async () => {
		await page.reload();
		await expect(page.getByText(/\bUp\b/).first()).toBeVisible({
			timeout: 2_000
		});
	}).toPass({ timeout: 60_000 });
	await remove(page, name);
});
