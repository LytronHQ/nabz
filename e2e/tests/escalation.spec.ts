import { test, expect } from '@playwright/test';
import { signIn } from './helpers';

// Escalation-policy CRUD BROWSER journey (#126): create a policy through the
// modal, see it listed, then delete it. A policy only requires a name (channels
// per level are optional), so this stays credential-free.

test('create an escalation policy via the UI, then delete it', async ({ page }) => {
	await signIn(page);
	await page.goto('/escalations');

	const name = 'e2e-escalation-policy';

	// Open the New-policy modal. Both the header and the empty state offer the
	// button, so take the first.
	await page.getByRole('button', { name: 'New policy' }).first().click();
	await page.getByLabel('Name', { exact: true }).fill(name);
	await page.getByRole('button', { name: 'Save', exact: true }).click();

	// It appears in the policy list.
	const card = page.locator('.pol-list .card').filter({ hasText: name });
	await expect(card).toBeVisible();

	// Delete it — accept the confirm dialog.
	page.on('dialog', (d) => d.accept());
	await card.getByRole('button', { name: 'Delete' }).click();
	await expect(page.locator('.pol-list .card').filter({ hasText: name })).toHaveCount(0);
});
