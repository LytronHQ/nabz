import { test, expect } from '@playwright/test';
import { signIn } from './helpers';

// There was no +error.svelte: a mistyped URL showed SvelteKit's bare "404 / Not
// Found" in the top-left corner signed out, and plain text with no way back
// signed in.

test('signed out, an unknown page is a card with a way home', async ({ page }) => {
	const res = await page.goto('/no-such-page');
	expect(res?.status()).toBe(404);
	await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
	await page.getByRole('link', { name: 'Go to the home page' }).click();
	await expect(page).toHaveURL(/\/$/);
});

test('signed in, a missing monitor says so and leads back to the dashboard', async ({ page }) => {
	await signIn(page);
	const res = await page.goto('/monitors/doesnotexist123');
	expect(res?.status()).toBe(404);
	await expect(page.getByText('Monitor not found')).toBeVisible();
	await page.getByRole('link', { name: 'Back to the dashboard' }).click();
	await expect(page).toHaveURL(/\/dashboard$/);
});
