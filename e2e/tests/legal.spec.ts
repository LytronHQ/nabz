import { test, expect } from '@playwright/test';

// The privacy policy and terms are published, not drafts (#554). Once the banner
// is gone they bind, so what they say must match production: the ap-southeast
// probe runs in Singapore, and there is no self-service account deletion.

for (const path of ['/privacy', '/terms']) {
	test(`${path} carries no draft banner`, async ({ page }) => {
		await page.goto(path);
		await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
		await expect(page.getByText(/DRAFT/)).toHaveCount(0);
	});
}

test('the privacy policy names every hosting location', async ({ page }) => {
	await page.goto('/privacy');
	const body = page.locator('.legal-body');
	await expect(body).toContainText('Germany');
	await expect(body).toContainText('Singapore');
});

test('the privacy policy does not promise a delete button the account page lacks', async ({
	page
}) => {
	await page.goto('/privacy');
	await expect(page.locator('.legal-body')).not.toContainText(
		/account page,? delete your account/i
	);
	await expect(page.locator('.legal-body')).toContainText('privacy@nabz.sh');
});

// It said "operated from the European Union"; nabz is run by Lytron Systems Ltd
// in the United Kingdom, and UK users have rights under UK data-protection law (#574).
test('the privacy policy names the real operator and its country', async ({ page }) => {
	await page.goto('/privacy');
	const body = page.locator('.legal-body');
	await expect(body).toContainText('Lytron Systems Ltd');
	await expect(body).toContainText('operated from the United Kingdom');
	await expect(body).not.toContainText('operated from the European Union');
	await expect(body).toContainText('If you are in the UK');
});
