import { test, expect, type Page } from '@playwright/test';
import { signIn } from './helpers';

// Keyboard use of the shared modal: Tab walked out of the dialog into the page
// behind the backdrop, and closing it dropped focus at the top of the document
// instead of on the button that opened it.

const inDialog = (page: Page) =>
	page.evaluate(() => !!document.activeElement?.closest('[role=dialog]'));

for (const [path, opener] of [
	['/alerts', /add (your first )?channel/i],
	['/escalations', /new policy/i]
] as const) {
	test(`${path}: Tab stays in the dialog, Escape returns focus to the opener`, async ({ page }) => {
		await signIn(page);
		await page.goto(path);
		const button = page.getByRole('button', { name: opener }).first();
		await button.focus();
		await page.keyboard.press('Enter');
		await expect(page.getByRole('dialog')).toBeVisible();
		expect(await inDialog(page)).toBe(true);
		for (let i = 0; i < 25; i++) {
			await page.keyboard.press(i % 5 === 4 ? 'Shift+Tab' : 'Tab');
			expect(await inDialog(page), `after key ${i + 1}`).toBe(true);
		}
		await page.keyboard.press('Escape');
		await expect(page.getByRole('dialog')).toHaveCount(0);
		await expect(button).toBeFocused();
	});
}
