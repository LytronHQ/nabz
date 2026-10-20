import { test, expect, type Page } from '@playwright/test';
import { signIn } from './helpers';

// Escalation policies with real levels: two levels, each with its own channel and
// delay, saved, reopened with the same values, assigned to a monitor, then
// removed. The older journey only filled the name.

const RUN = Date.now().toString(36);

async function addWebhookChannel(page: Page, name: string) {
	await page.goto('/alerts');
	await page
		.getByRole('button', { name: /add (your first )?channel/i })
		.first()
		.click();
	const d = page.getByRole('dialog');
	await d.getByPlaceholder('e.g. On-call Slack').fill(name);
	await d.getByLabel('Webhook URL').fill('http://fixture:8080/echo');
	await d.getByRole('button', { name: 'Add Channel', exact: true }).click();
	await expect(page.getByRole('row').filter({ hasText: name })).toBeVisible();
}

async function deleteRow(page: Page, path: string, name: string) {
	await page.goto(path);
	page.once('dialog', (d) => d.accept());
	await page
		.getByRole('row')
		.filter({ hasText: name })
		.getByRole('button', { name: 'Delete' })
		.click();
	await expect(page.getByRole('row').filter({ hasText: name })).toHaveCount(0);
}

test('escalation policy: two levels with their own channels and delays, edit, assign, delete', async ({
	page
}) => {
	await signIn(page);
	const chA = `e2e-esc-a-${RUN}`;
	const chB = `e2e-esc-b-${RUN}`;
	await addWebhookChannel(page, chA);
	await addWebhookChannel(page, chB);

	const policy = `e2e-two-levels-${RUN}`;
	await page.goto('/escalations');
	await page.getByRole('button', { name: 'New policy' }).first().click();
	const m = page.getByRole('dialog');
	await m.getByPlaceholder('Critical').fill(policy);
	const levels = m.locator('.lvl');
	await expect(levels).toHaveCount(1);
	await levels.nth(0).locator('label.chan').filter({ hasText: chA }).click();
	await expect(levels.nth(0).locator('label.chan').filter({ hasText: chA })).toHaveClass(/on/);
	await m.getByRole('button', { name: '+ Add level' }).click();
	await expect(levels).toHaveCount(2);
	await levels.nth(1).locator('input[type=number]').fill('10');
	await levels.nth(1).locator('label.chan').filter({ hasText: chB }).click();
	await m.getByRole('button', { name: 'Save', exact: true }).click();

	const card = page.locator('.pol-list .card').filter({ hasText: policy });
	await expect(card).toBeVisible();
	await expect(card).toContainText(chA);
	await expect(card).toContainText(chB);

	// Reopen: both levels, their delays and their channels come back.
	await card.getByRole('button', { name: /edit/i }).click();
	const e = page.getByRole('dialog');
	await expect(e.locator('.lvl')).toHaveCount(2);
	await expect(e.locator('.lvl').nth(1).locator('input[type=number]')).toHaveValue('10');
	await expect(e.locator('.lvl').nth(0).locator('label.chan').filter({ hasText: chA })).toHaveClass(
		/on/
	);
	await expect(e.locator('.lvl').nth(1).locator('label.chan').filter({ hasText: chB })).toHaveClass(
		/on/
	);
	await expect(
		e.locator('.lvl').nth(0).locator('label.chan').filter({ hasText: chB })
	).not.toHaveClass(/on/);
	await e.getByRole('button', { name: 'Cancel' }).click();

	// Assign it to a new monitor through the monitor form.
	const mon = `e2e-esc-monitor-${RUN}`;
	await page.goto('/monitors/new');
	await page.getByLabel('Name', { exact: true }).fill(mon);
	await page.getByLabel('URL', { exact: true }).fill('http://fixture:8080/status/200');
	await page.getByLabel('Interval (seconds)').fill('30');
	const policySelect = page.locator('select.form-input').last();
	await policySelect.selectOption({ label: policy });
	await page.getByRole('button', { name: 'Add monitor' }).click();
	await expect(page).toHaveURL(/\/monitors$/);
	const row = page.getByRole('row').filter({ hasText: mon });
	await row.getByRole('button', { name: 'Edit' }).click();
	await expect(page.locator('select.form-input').last().locator('option:checked')).toHaveText(
		policy
	);

	// Clean up: monitor, policy, channels.
	await deleteRow(page, '/monitors', mon);
	await page.goto('/escalations');
	page.once('dialog', (d) => d.accept());
	await page
		.locator('.pol-list .card')
		.filter({ hasText: policy })
		.getByRole('button', { name: /delete/i })
		.click();
	await expect(page.locator('.pol-list .card').filter({ hasText: policy })).toHaveCount(0);
	await deleteRow(page, '/alerts', chA);
	await deleteRow(page, '/alerts', chB);
});
