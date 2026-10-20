import { test, expect } from '@playwright/test';
import { signIn } from './helpers';

// A signed-in user who opened /signup (a bookmark, the landing page's "Get
// started") got "Create your account" inside the app shell, as if signed out.

for (const path of ['/signup', '/signin']) {
	test(`signed in, ${path} goes to the dashboard`, async ({ page }) => {
		await signIn(page);
		await page.goto(path);
		await expect(page).toHaveURL(/\/dashboard$/);
	});
}
