import { test, expect } from '@playwright/test';
import { signIn } from './helpers';

// Alert-channel CRUD BROWSER journey (#126): create a webhook channel through the
// modal form, see it listed, then delete it. No real delivery happens here — this
// covers the create/read/delete of the channel config (webhook is the default
// type, so no custom Select interaction is needed).

test('create a webhook alert channel via the UI, then delete it', async ({ page }) => {
	await signIn(page);
	await page.goto('/alerts');

	const name = 'e2e-webhook-channel';

	// Open the add-channel modal. `exact` distinguishes the page's "Add channel"
	// button from the modal's "Add Channel" submit button.
	await page.getByRole('button', { name: 'Add channel', exact: true }).click();

	// Fill it — webhook is the default type, so just name + the webhook URL field.
	await page.getByPlaceholder('e.g. On-call Slack').fill(name);
	await page.getByLabel('Webhook URL').fill('http://fixture:8080/echo');
	await page.getByRole('button', { name: 'Add Channel', exact: true }).click();

	// It appears in the list, typed as a webhook.
	const row = page.getByRole('row').filter({ hasText: name });
	await expect(row).toBeVisible();
	await expect(row).toContainText('webhook');

	// Delete it — accept the confirm dialog.
	page.on('dialog', (d) => d.accept());
	await row.getByRole('button', { name: 'Delete' }).click();
	await expect(page.getByRole('row').filter({ hasText: name })).toHaveCount(0);
});
