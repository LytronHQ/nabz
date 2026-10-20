import { test, expect } from '@playwright/test';
import { signIn } from './helpers';

// Linking two monitors the way a user does: pick both, Add, see the link in the
// list and as an edge in the graph, survive a reload, then Remove it. The forms
// spec only checked that this page renders.

const RUN = Date.now().toString(36);

async function addMonitor(page: import('@playwright/test').Page, name: string) {
	await page.goto('/monitors/new');
	await page.getByLabel('Name', { exact: true }).fill(name);
	await page.getByLabel('URL', { exact: true }).fill('http://fixture:8080/status/200');
	await page.getByLabel('Interval (seconds)').fill('30');
	await page.getByRole('button', { name: 'Add monitor' }).click();
	await expect(page).toHaveURL(/\/monitors$/);
}

test('link two monitors, see the edge, reload, remove', async ({ page }) => {
	await signIn(page);
	const a = `e2e-dep-api-${RUN}`;
	const b = `e2e-dep-db-${RUN}`;
	await addMonitor(page, a);
	await addMonitor(page, b);

	await page.goto('/monitors/dependencies');
	await page.getByLabel('Monitor that depends on another').selectOption({ label: a });
	await page.getByLabel('Monitor it depends on').selectOption({ label: b });
	await page.getByRole('button', { name: 'Add', exact: true }).click();
	await expect(page.getByText('Dependency added')).toBeVisible();

	const row = page.locator('li.edge').filter({ hasText: a }).filter({ hasText: b });
	await expect(row).toHaveCount(1);
	await expect(
		page.locator('svg[role=img] line.edge, svg[role=img] path.edge').first()
	).toBeAttached();

	await page.reload();
	await expect(row).toHaveCount(1);

	page.once('dialog', (d) => d.accept());
	await row.getByRole('button', { name: 'Remove' }).click();
	await expect(page.getByText('Dependency removed')).toBeVisible();
	await expect(row).toHaveCount(0);
	await page.reload();
	await expect(row).toHaveCount(0);

	for (const name of [a, b]) {
		await page.goto('/monitors');
		await page.getByRole('searchbox').fill(name);
		page.once('dialog', (d) => d.accept());
		await page
			.getByRole('row')
			.filter({ hasText: name })
			.getByRole('button', { name: 'Delete' })
			.click();
		await expect(page.getByRole('row').filter({ hasText: name })).toHaveCount(0);
	}
});
