import { test, expect } from '@playwright/test';

// The signed-out pages: sign in, sign up, and the ones around a password reset or an email confirmation. They
// rendered as bare forms in the top-left corner of an empty page, unlike the
// sign-in card, and a truncated reset link (mail clients wrap long URLs) threw
// out of the page loader and answered "500 Internal Error".

const pages = [
	'/signin',
	'/signup',
	'/reset-password',
	'/reset-password/success-request',
	'/reset-password/success',
	'/auth/confirm-verification/not-a-token',
	'/auth/confirm-email-change/not-a-token',
	'/auth/confirm-password-reset/not-a-token'
];

for (const path of pages) {
	test(`${path} is the centred auth card`, async ({ page }) => {
		const res = await page.goto(path);
		expect(res?.status(), 'status').toBeLessThan(400);
		const card = page.locator('.auth-card');
		await expect(card).toBeVisible();
		const box = await card.boundingBox();
		const vw = page.viewportSize()!.width;
		expect(Math.abs(box!.x + box!.width / 2 - vw / 2), 'horizontally centred').toBeLessThan(4);
		// The logo mark rendered 0×0 on every auth card (its rule only matched .brand).
		const mark = await card.locator('.auth-brand .mark').boundingBox();
		expect(mark?.width, 'logo mark width').toBe(26);
	});
}

test('a broken reset link explains itself and offers a new one', async ({ page }) => {
	await page.goto('/auth/confirm-password-reset/not-a-token');
	await expect(page.getByText(/invalid or incomplete/)).toBeVisible();
	await page.getByRole('link', { name: 'Send a new link' }).click();
	await expect(page).toHaveURL(/\/reset-password$/);
});

test('a well-formed reset link shows whose password is being set', async ({ page }) => {
	// Unsigned is fine: the page only decodes the address; PocketBase checks the
	// signature when the form is submitted.
	const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
	const token = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ email: 'someone@example.com' })}.sig`;
	await page.goto(`/auth/confirm-password-reset/${token}`);
	await expect(page.getByText('someone@example.com')).toBeVisible();
	await expect(page.getByLabel('New password', { exact: true })).toBeVisible();
	await expect(page.getByLabel('Confirm new password')).toBeVisible();
});
