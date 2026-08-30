import { test, expect } from '@playwright/test';
import { signIn, USER } from './helpers';

// First BROWSER journey (#126): the real auth + navigation flow through the UI —
// SvelteKit form action → PocketBase login → pb_auth cookie → guarded routes.
// The API pipeline test doesn't touch any of this. Uses the seeded dashboard user.

test('a protected route redirects to sign-in when signed out', async ({ page }) => {
	await page.goto('/monitors');
	await expect(page).toHaveURL(/\/signin/);
});

test('sign in, navigate the app, then sign out re-guards', async ({ page }) => {
	await signIn(page);

	// Main nav → Monitors (exact keeps it off any other link that contains "Monitors").
	await page.getByRole('link', { name: 'Monitors', exact: true }).click();
	await expect(page).toHaveURL(/\/monitors$/);

	// The Monitors section's sub-nav (#223) switches views — reach Dependencies.
	await page.getByRole('link', { name: 'Dependencies' }).click();
	await expect(page).toHaveURL(/\/monitors\/dependencies/);
	await expect(page.getByRole('heading', { name: 'Dependencies' })).toBeVisible();

	// Sign out, then the guard is back in force: a protected route redirects to
	// sign-in again (proving the session is gone).
	await page.getByRole('link', { name: 'Sign out' }).click();
	await expect(page).not.toHaveURL(/\/(dashboard|monitors|dependencies)/);
	await page.goto('/monitors');
	await expect(page).toHaveURL(/\/signin/);
});

test('rejects bad credentials', async ({ page }) => {
	await page.goto('/signin');
	await page.getByLabel('Email').fill(USER);
	await page.getByLabel('Password').fill('wrong-password');
	await page.getByRole('button', { name: 'Sign in' }).click();
	// Stays on sign-in — no redirect to the dashboard.
	await expect(page).toHaveURL(/\/signin/);
	await expect(page).not.toHaveURL(/\/dashboard/);
});
