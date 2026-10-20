import { test, expect, type Page } from '@playwright/test';

// The account lifecycle a new customer walks, on a FRESH account each run so the
// shared e2e user is never changed: sign up, land in the app, rename yourself,
// change your password, sign out, sign back in with the new password, and ask
// for a password reset.

const RUN = Date.now().toString(36);
const EMAIL = `e2e-${RUN}@example.com`;
const PASS1 = `first-pass-${RUN}`;
const PASS2 = `second-pass-${RUN}`;

async function signInAs(page: Page, email: string, password: string) {
	await page.goto('/signin');
	await page.getByLabel('Email', { exact: true }).fill(email);
	await page.getByLabel('Password').fill(password);
	await page.getByRole('button', { name: 'Sign in' }).click();
}

test.describe.serial('a new account, end to end', () => {
	test('sign up lands in the app', async ({ page }) => {
		await page.goto('/signup');
		await page.getByLabel('Email').fill(EMAIL);
		await page.getByLabel('Password', { exact: true }).fill(PASS1);
		await page.getByLabel('Confirm password').fill(PASS1);
		await page.getByRole('button', { name: 'Sign up' }).click();
		// Either straight into the app, or a page that says what to do next — never
		// back on /signup with no message.
		await expect(page).not.toHaveURL(/\/signup$/, { timeout: 15_000 });
	});

	test('the new account can sign in and rename itself', async ({ page }) => {
		await signInAs(page, EMAIL, PASS1);
		await expect(page).toHaveURL(/\/dashboard|\/change-password/);
		await page.goto('/account');
		await page.getByLabel('Display name').fill(`E2E ${RUN}`);
		await page.getByRole('button', { name: 'Save profile' }).click();
		// Wait for the save to land: reloading straight after the click raced the
		// request and failed the full suite once under load.
		await expect(page.getByText('Profile updated.')).toBeVisible();
		await page.reload();
		await expect(page.getByLabel('Display name')).toHaveValue(`E2E ${RUN}`);
		await expect(page.getByRole('link', { name: new RegExp(`E2E ${RUN}`) })).toBeVisible();
	});

	test('change password, sign out, sign in with the new one', async ({ page }) => {
		await signInAs(page, EMAIL, PASS1);
		await page.goto('/account');
		await page.getByLabel('Current password').fill(PASS1);
		await page.getByLabel('New password', { exact: true }).fill(PASS2);
		await page.getByLabel('Confirm new password').fill(PASS2);
		await page.getByRole('button', { name: 'Change password' }).click();
		await expect(page.getByText(/Your password has been changed/)).toBeVisible();
		// Sign out through the app, then: the old password is refused, the new works.
		await page.goto('/account');
		await page.getByRole('link', { name: 'Sign out' }).first().click();
		await expect(page).not.toHaveURL(/\/account/);
		await page.goto('/dashboard');
		await expect(page).toHaveURL(/\/signin/);
		await signInAs(page, EMAIL, PASS1);
		await expect(page.getByText('Invalid username or password')).toBeVisible();
		await signInAs(page, EMAIL, PASS2);
		await expect(page).toHaveURL(/\/dashboard/);
	});

	test('asking for a password reset says it was sent', async ({ page }) => {
		await page.goto('/reset-password');
		await page.getByLabel('Your email').fill(EMAIL);
		await page.getByRole('button', { name: 'Send me an email for password reset' }).click();
		await expect(page).toHaveURL(/\/reset-password\/success-request/);
	});
});
