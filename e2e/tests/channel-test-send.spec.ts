import { test, expect } from '@playwright/test';
import { signIn } from './helpers';

// "Send a test to any of them with a click" — the landing page promises it. A
// webhook channel pointed at the fixture, opened from the list, tested: the
// evaluator delivers it and the channel's delivery log shows it, not failed.

const RUN = Date.now().toString(36);

test('send test from a channel page: the delivery shows in its log', async ({ page }) => {
	await signIn(page);
	const name = `e2e-test-send-${RUN}`;
	await page.goto('/alerts');
	await page
		.getByRole('button', { name: /add (your first )?channel/i })
		.first()
		.click();
	const d = page.getByRole('dialog');
	await d.getByPlaceholder('e.g. On-call Slack').fill(name);
	await d.getByLabel('Webhook URL').fill('http://fixture:8080/echo');
	await d.getByRole('button', { name: 'Add Channel', exact: true }).click();

	await page.getByRole('row').filter({ hasText: name }).getByRole('link', { name }).click();
	await expect(page).toHaveURL(/\/alerts\/[a-z0-9]+$/);
	// Titled with its name: two webhook channels used to both read "Webhook".
	await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
	// Its destination, masked — this line was blank for every config-based channel.
	await expect(page.getByText('fixture:8080 · …0/echo')).toBeVisible();
	await expect(page.getByText('No deliveries yet')).toBeVisible();
	await page.getByRole('button', { name: 'Send test' }).click();
	await expect(page.getByRole('button', { name: 'Send test' })).toBeEnabled();

	// Delivered by the evaluator, asynchronously.
	const item = page.locator('li.log-item').first();
	await expect(async () => {
		await page.reload();
		await expect(item).toBeVisible({ timeout: 2_000 });
	}).toPass({ timeout: 90_000 });
	await expect(item).not.toHaveClass(/failed|error/);

	await page.goto('/alerts');
	page.once('dialog', (dl) => dl.accept());
	await page
		.getByRole('row')
		.filter({ hasText: name })
		.getByRole('button', { name: 'Delete' })
		.click();
	await expect(page.getByRole('row').filter({ hasText: name })).toHaveCount(0);
});
