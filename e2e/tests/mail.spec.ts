import { test, expect, type APIRequestContext } from '@playwright/test';

// Account emails (#627): PocketBase sends them through the stack's mail catcher
// (mailpit), and the link in each must land on the web's own page and work.
// Production never sent one: no SMTP, no app URL, and templates that linked to
// PocketBase's admin UI.

const PB = process.env.E2E_PB || 'http://127.0.0.1:8390';
const MAIL = process.env.E2E_MAIL || 'http://127.0.0.1:8025';
const WEB = process.env.E2E_WEB_URL || 'http://127.0.0.1:4390';
const SU_EMAIL = process.env.E2E_SUPERUSER_EMAIL || 'admin@e2e.local';
const SU_PASS = process.env.E2E_SUPERUSER_PASSWORD || 'e2e-superuser-pass';

const unique = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function suToken(api: APIRequestContext) {
	const res = await api.post(`${PB}/api/collections/_superusers/auth-with-password`, {
		data: { identity: SU_EMAIL, password: SU_PASS }
	});
	expect(res.ok()).toBeTruthy();
	return (await res.json()).token as string;
}

// The link in the newest mail to `to` whose path starts with `path`.
async function linkFromMail(api: APIRequestContext, to: string, path: string) {
	let html = '';
	await expect
		.poll(
			async () => {
				const search = await api.get(
					`${MAIL}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`
				);
				const id = (await search.json()).messages?.[0]?.ID;
				if (!id) return '';
				html = (await (await api.get(`${MAIL}/api/v1/message/${id}`)).json()).HTML ?? '';
				return html;
			},
			{ message: `no mail to ${to}`, timeout: 30_000 }
		)
		.toContain(path);
	const href = html
		.match(/href="([^"]+)"/g)
		?.map((h) => h.slice(6, -1))
		.find((h) => h.includes(path));
	expect(href, 'link in the mail').toBeTruthy();
	return href!;
}

test('signing up sends a verification email whose link verifies the account', async ({
	page,
	request
}) => {
	const email = `verify-${unique()}@e2e.local`;
	await page.goto('/signup');
	await page.getByLabel('Email').fill(email);
	await page.getByLabel('Password', { exact: true }).fill('verify-password-1');
	await page.getByLabel('Confirm password').fill('verify-password-1');
	await page.getByRole('button', { name: 'Sign up' }).click();

	const link = await linkFromMail(request, email, '/auth/confirm-verification/');
	// The web's own page on the web's origin, not PocketBase's admin UI.
	expect(link.startsWith(`${WEB}/auth/confirm-verification/`)).toBe(true);
	await page.goto(link);
	await expect(page.getByText('Successfully verified your email address')).toBeVisible();

	const token = await suToken(request);
	const users = await request.get(
		`${PB}/api/collections/users/records?filter=${encodeURIComponent(`email = "${email}"`)}`,
		{ headers: { Authorization: token } }
	);
	expect((await users.json()).items[0]).toMatchObject({ verified: true });
});

test('a password reset email lets the user set a new password and sign in with it', async ({
	page,
	request
}) => {
	const email = `reset-${unique()}@e2e.local`;
	const token = await suToken(request);
	const created = await request.post(`${PB}/api/collections/users/records`, {
		headers: { Authorization: token },
		data: { email, password: 'old-password-1', passwordConfirm: 'old-password-1', verified: true }
	});
	expect(created.ok()).toBeTruthy();

	await page.goto('/reset-password');
	await page.getByLabel('Your email').fill(email);
	await page.getByRole('button', { name: 'Send me an email for password reset' }).click();
	await expect(page).toHaveURL(/\/reset-password\/success-request/);

	const link = await linkFromMail(request, email, '/auth/confirm-password-reset/');
	expect(link.startsWith(`${WEB}/auth/confirm-password-reset/`)).toBe(true);
	await page.goto(link);
	await page.getByLabel('New password', { exact: true }).fill('new-password-1');
	await page.getByLabel('Confirm new password').fill('new-password-1');
	await page.getByRole('button', { name: 'Set new password' }).click();
	await expect(page).toHaveURL(/\/reset-password\/success/);

	await page.goto('/signin');
	await page.getByLabel('Email').fill(email);
	await page.getByLabel('Password').fill('new-password-1');
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL(/\/dashboard/);
});
