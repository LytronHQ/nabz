import { expect, type Page } from '@playwright/test';

export const USER = process.env.E2E_USER_EMAIL || 'user@e2e.local';
export const PASS = process.env.E2E_USER_PASSWORD || 'e2e-user-pass';

// Sign in through the real UI (SvelteKit form action → PocketBase → pb_auth
// cookie) and land on the dashboard. Shared by the browser journeys.
export async function signIn(page: Page) {
	await page.goto('/signin');
	await page.getByLabel('Email').fill(USER);
	await page.getByLabel('Password').fill(PASS);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL(/\/dashboard/);
}
