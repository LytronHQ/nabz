import { test, expect } from '@playwright/test';

// A session that ends under an open tab (#633): after a password change, which
// invalidates every PocketBase token of the user, the next in-app navigation must
// land on a plain sign-in page, not the signed-in shell wrapped around it. The
// root layout's data was reused across client-side navigations, so the sidebar
// and the account card stayed while the page said "signed out".

const PB = process.env.E2E_PB || 'http://127.0.0.1:8390';
const SU_EMAIL = process.env.E2E_SUPERUSER_EMAIL || 'admin@e2e.local';
const SU_PASS = process.env.E2E_SUPERUSER_PASSWORD || 'e2e-superuser-pass';

test('when the session ends, the next navigation shows sign-in without the app shell', async ({
	page,
	request
}) => {
	const email = `session-${Date.now()}@e2e.local`;
	const su = await request.post(`${PB}/api/collections/_superusers/auth-with-password`, {
		data: { identity: SU_EMAIL, password: SU_PASS }
	});
	const token = (await su.json()).token as string;
	const created = await request.post(`${PB}/api/collections/users/records`, {
		headers: { Authorization: token },
		data: {
			email,
			password: 'first-password-1',
			passwordConfirm: 'first-password-1',
			verified: true
		}
	});
	expect(created.ok()).toBeTruthy();
	const userId = (await created.json()).id as string;

	await page.goto('/signin');
	await page.getByLabel('Email').fill(email);
	await page.getByLabel('Password').fill('first-password-1');
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL(/\/dashboard/);
	await expect(page.getByRole('link', { name: 'Sign out' })).toBeVisible();

	// A password change elsewhere (a reset link, another device) ends this session.
	const changed = await request.patch(`${PB}/api/collections/users/records/${userId}`, {
		headers: { Authorization: token },
		data: { password: 'second-password-1', passwordConfirm: 'second-password-1' }
	});
	expect(changed.ok()).toBeTruthy();

	// An in-app (client-side) navigation, as a click in the sidebar does.
	await page.getByRole('link', { name: 'Monitors', exact: true }).click();
	await expect(page).toHaveURL(/\/signin/);
	await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
	// No shell from the ended session around it.
	await expect(page.getByRole('link', { name: 'Sign out' })).toHaveCount(0);
	await expect(page.getByText(email)).toHaveCount(0);
});
