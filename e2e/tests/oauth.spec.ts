import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

// Sign in with GitHub (#609), end to end: the real web routes and PocketBase's
// real github provider, with only the provider's endpoints moved to the fixture's
// fake GitHub (e2e/setup.sh → deploy/pb-oauth.sh). Each test picks the identity
// the fake hands out next with POST /oauth/github/next.

const PB = process.env.E2E_PB || 'http://127.0.0.1:8390';
const FIXTURE = process.env.E2E_FIXTURE || 'http://127.0.0.1:8788';
const SU_EMAIL = process.env.E2E_SUPERUSER_EMAIL || 'admin@e2e.local';
const SU_PASS = process.env.E2E_SUPERUSER_PASSWORD || 'e2e-superuser-pass';

// The fake hands out one identity per authorize, so the tests take turns.
test.describe.configure({ mode: 'serial' });

async function suToken(api: APIRequestContext): Promise<string> {
	const res = await api.post(`${PB}/api/collections/_superusers/auth-with-password`, {
		data: { identity: SU_EMAIL, password: SU_PASS }
	});
	expect(res.ok(), `superuser auth failed: ${res.status()}`).toBeTruthy();
	return (await res.json()).token as string;
}

async function usersByEmail(api: APIRequestContext, email: string) {
	const token = await suToken(api);
	const res = await api.get(
		`${PB}/api/collections/users/records?filter=${encodeURIComponent(`email = "${email}"`)}`,
		{ headers: { Authorization: token } }
	);
	expect(res.ok()).toBeTruthy();
	return (await res.json()).items as Record<string, unknown>[];
}

async function nextIdentity(api: APIRequestContext, who: Record<string, unknown>) {
	const res = await api.post(`${FIXTURE}/oauth/github/next`, { data: who });
	expect(res.ok()).toBeTruthy();
}

const unique = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

test('a new GitHub user gets a verified account with their name', async ({ page, request }) => {
	const id = unique();
	const email = `octo-${id}@e2e.local`;
	await nextIdentity(request, {
		id: Number(id.replace(/\D/g, '').slice(-9)),
		login: `octo${id}`,
		name: 'Octo Cat',
		email
	});

	await page.goto('/signin');
	await page.getByRole('link', { name: 'Continue with GitHub' }).click();
	await expect(page).toHaveURL(/\/dashboard/);

	const [user, ...rest] = await usersByEmail(request, email);
	expect(rest).toHaveLength(0);
	expect(user).toMatchObject({ name: 'Octo Cat', verified: true });
	// The picture is not checked here: PocketBase >= 0.30 downloads it through a
	// client that refuses private addresses, and the fixture is one. The mapping
	// itself (avatarURL -> avatar) is pinned by deploy/pb_oauth_test.sh.
});

test('a GitHub sign-in with an existing email lands in that account, unchanged', async ({
	page,
	request
}) => {
	const id = unique();
	const email = `keep-${id}@e2e.local`;
	const password = 'kept-password-1';
	const token = await suToken(request);
	const created = await request.post(`${PB}/api/collections/users/records`, {
		headers: { Authorization: token },
		data: { email, password, passwordConfirm: password, name: 'Kept Name', verified: true }
	});
	expect(created.ok()).toBeTruthy();
	const existingId = (await created.json()).id;

	await nextIdentity(request, {
		id: Number(id.replace(/\D/g, '').slice(-9)),
		login: `keep${id}`,
		name: 'Name From GitHub',
		email
	});
	await page.goto('/signin');
	await page.getByRole('link', { name: 'Continue with GitHub' }).click();
	await expect(page).toHaveURL(/\/dashboard/);

	// The same account: not a second user, and the name the user chose stays.
	const users = await usersByEmail(request, email);
	expect(users).toHaveLength(1);
	expect(users[0]).toMatchObject({ id: existingId, name: 'Kept Name' });
	// A verified account keeps its password: GitHub is an extra way in, not a reset.
	const pw = await request.post(`${PB}/api/collections/users/auth-with-password`, {
		data: { identity: email, password }
	});
	expect(pw.ok()).toBeTruthy();
});

test('Cancel on the provider page comes back to /signin and says so', async ({ page, request }) => {
	await nextIdentity(request, { deny: true });
	await page.goto('/signin');
	await page.getByRole('link', { name: 'Continue with GitHub' }).click();
	await expect(page).toHaveURL(/\/signin\?oauth=cancelled/);
	await expect(page.getByText('Sign-in was cancelled. Nothing was changed.')).toBeVisible();
});

test('sign-up offers the same buttons', async ({ page }) => {
	await page.goto('/signup');
	await expect(page.getByRole('link', { name: 'Continue with GitHub' })).toBeVisible();
	// Only GitHub is configured in e2e: no button for a provider that is off.
	await expect(page.getByRole('link', { name: 'Continue with Google' })).toHaveCount(0);
});

// Connected accounts on /account (#622).
async function makeUser(api: APIRequestContext, email: string, password: string) {
	const token = await suToken(api);
	const res = await api.post(`${PB}/api/collections/users/records`, {
		headers: { Authorization: token },
		data: { email, password, passwordConfirm: password, name: 'Linker', verified: true }
	});
	expect(res.ok()).toBeTruthy();
	return (await res.json()).id as string;
}

async function signInWithPassword(page: Page, email: string, password: string) {
	await page.goto('/signin');
	await page.getByLabel('Email').fill(email);
	await page.getByLabel('Password').fill(password);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL(/\/dashboard/);
}

test('connect GitHub with a different email, sign in with it, then disconnect', async ({
	page,
	request
}) => {
	const id = unique();
	const email = `link-${id}@e2e.local`;
	await makeUser(request, email, 'link-password-1');
	await signInWithPassword(page, email, 'link-password-1');

	await page.goto('/account');
	const card = page.locator('.card', {
		has: page.getByRole('heading', { name: 'Sign-in methods' })
	});
	await expect(card.getByText('Not connected')).toBeVisible();
	// A GitHub identity with a DIFFERENT email: linking follows the session, not the email.
	const githubId = Number(id.replace(/\D/g, '').slice(-9));
	await nextIdentity(request, {
		id: githubId,
		login: `gh${id}`,
		name: 'GH',
		email: `other-${id}@e2e.local`
	});
	await card.getByRole('link', { name: 'Connect GitHub' }).click();
	await expect(page).toHaveURL(/\/account\?connect=connected&provider=github/);
	await expect(page.getByText('GitHub is connected. You can now sign in with it.')).toBeVisible();
	await expect(card.getByText('Connected', { exact: true })).toBeVisible();

	// Signed out, GitHub now opens this same account.
	await page.getByRole('link', { name: 'Sign out' }).click();
	// Let sign-out finish: a goto during its redirect is aborted.
	await expect(page).not.toHaveURL(/\/(dashboard|account)/);
	await nextIdentity(request, {
		id: githubId,
		login: `gh${id}`,
		name: 'GH',
		email: `other-${id}@e2e.local`
	});
	await page.goto('/signin');
	await page.getByRole('link', { name: 'Continue with GitHub' }).click();
	await expect(page).toHaveURL(/\/dashboard/);
	await expect(page.getByRole('link', { name: new RegExp(email) })).toBeVisible();
	// ...without a second user for the GitHub email.
	expect(await usersByEmail(request, `other-${id}@e2e.local`)).toHaveLength(0);

	await page.goto('/account');
	await card.getByRole('button', { name: 'Disconnect GitHub' }).click();
	await expect(page.getByText('Disconnected.', { exact: false })).toBeVisible();
	await expect(card.getByText('Not connected')).toBeVisible();
});

test('a GitHub account already connected elsewhere is refused, and the session stays', async ({
	page,
	request
}) => {
	const id = unique();
	const githubId = Number(id.replace(/\D/g, '').slice(-9));
	// Someone signs up with this GitHub identity.
	await nextIdentity(request, {
		id: githubId,
		login: `own${id}`,
		name: 'Owner',
		email: `owner-${id}@e2e.local`
	});
	await page.goto('/signin');
	await page.getByRole('link', { name: 'Continue with GitHub' }).click();
	await expect(page).toHaveURL(/\/dashboard/);
	await page.getByRole('link', { name: 'Sign out' }).click();
	// Let sign-out finish: a goto during its redirect is aborted.
	await expect(page).not.toHaveURL(/\/(dashboard|account)/);

	// A different user tries to connect the same identity.
	const email = `second-${id}@e2e.local`;
	await makeUser(request, email, 'second-password-1');
	await signInWithPassword(page, email, 'second-password-1');
	await page.goto('/account');
	await nextIdentity(request, {
		id: githubId,
		login: `own${id}`,
		name: 'Owner',
		email: `owner-${id}@e2e.local`
	});
	await page.getByRole('link', { name: 'Connect GitHub' }).click();
	await expect(page).toHaveURL(/connect=taken/);
	await expect(page.getByText(/already connected to another nabz account/)).toBeVisible();
	// Still the second user, not switched into the owner's account.
	await expect(page.getByRole('link', { name: new RegExp(email) })).toBeVisible();
});
