import { test, expect } from '@playwright/test';
import { signIn } from './helpers';

// Monitor-CRUD BROWSER journey (#126): create a monitor through the real form,
// see it in the list, then delete it — the create/read/delete path a user
// actually walks. Website is the default type, so no custom Select interaction
// is needed. The target points at the fixture on the compose network.
const FIXTURE = 'http://fixture:8080';

test('create a website monitor through the UI, then delete it', async ({ page }) => {
	await signIn(page);

	const name = 'e2e-ui-monitor';

	// Create via the form.
	await page.goto('/monitors/new');
	// `exact` — "Name" is also a substring of the custom-headers field's label.
	await page.getByLabel('Name', { exact: true }).fill(name);
	await page.getByLabel('URL', { exact: true }).fill(`${FIXTURE}/status/200`);
	// >= the 30s floor (#319): the input has min="30", so a smaller value makes
	// the browser refuse to submit the form and this journey never completes.
	await page.getByLabel('Interval (seconds)').fill('30');
	await page.getByRole('button', { name: 'Add monitor' }).click();

	// Back on the list, and the new monitor is shown (name + its target URL).
	await expect(page).toHaveURL(/\/monitors$/);
	const row = page.getByRole('row').filter({ hasText: name });
	await expect(row).toBeVisible();
	await expect(row).toContainText(`${FIXTURE}/status/200`);

	// Delete it — the app asks for confirmation, so accept the dialog.
	page.on('dialog', (d) => d.accept());
	await row.getByRole('button', { name: 'Delete' }).click();

	// The row is gone.
	await expect(page.getByRole('row').filter({ hasText: name })).toHaveCount(0);
});
