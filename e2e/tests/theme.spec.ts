import { test, expect, type Page } from '@playwright/test';
import { signIn } from './helpers';

// Light and dark, the way a user switches them. The page body kept a light
// background in dark mode (an inline style in app.html beat the stylesheet), so
// every place the body shows through — below a short page, behind a modal — was
// a light-gray slab in an otherwise dark app.

const DARK = 'rgb(15, 23, 25)'; // --bg, dark
const LIGHT = 'rgb(236, 240, 241)'; // --bg, light

const bodyBg = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

test.describe('system dark', () => {
	test.use({ colorScheme: 'dark' });

	test('the page body is dark, signed out and signed in', async ({ page }) => {
		await page.goto('/signin');
		expect(await bodyBg(page)).toBe(DARK);
		await signIn(page);
		await page.goto('/alerts');
		expect(await bodyBg(page)).toBe(DARK);
	});

	test('Light theme wins over a dark system, and survives a reload', async ({ page }) => {
		await signIn(page);
		await page.getByRole('button', { name: 'Light theme' }).click();
		expect(await bodyBg(page)).toBe(LIGHT);
		await page.reload();
		expect(await bodyBg(page)).toBe(LIGHT);
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
		await page.getByRole('button', { name: 'System theme' }).click();
		expect(await bodyBg(page)).toBe(DARK);
	});
});

test.describe('system light', () => {
	test.use({ colorScheme: 'light' });

	test('Dark theme wins over a light system, and survives a reload', async ({ page }) => {
		await signIn(page);
		expect(await bodyBg(page)).toBe(LIGHT);
		await page.getByRole('button', { name: 'Dark theme' }).click();
		expect(await bodyBg(page)).toBe(DARK);
		await page.reload();
		expect(await bodyBg(page)).toBe(DARK);
		await page.getByRole('button', { name: 'System theme' }).click();
		expect(await bodyBg(page)).toBe(LIGHT);
	});

	test('an accent choice survives a reload', async ({ page }) => {
		await signIn(page);
		await page.getByRole('button', { name: 'rose accent' }).click();
		await expect(page.locator('html')).toHaveAttribute('data-accent', 'rose');
		await page.reload();
		await expect(page.locator('html')).toHaveAttribute('data-accent', 'rose');
		await expect(page.getByRole('button', { name: 'rose accent' })).toHaveAttribute(
			'aria-pressed',
			'true'
		);
		await page.getByRole('button', { name: 'petrol accent' }).click();
	});
});

// The public pages (landing, changelog, legal) follow the visitor's theme like
// the app, with a one-click switch in their top bar (#556). They used to be
// pinned dark (#79), and before #528 the pin silently rendered them light with
// dark-on-dark code chips — so contrast is checked in both themes.
const lum = (rgb: string) => {
	const [r, g, b] = (rgb.match(/[\d.]+/g) ?? [])
		.slice(0, 3)
		.map(Number)
		.map((v) => {
			const c = v / 255;
			return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
		});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
	const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
	return (x + 0.05) / (y + 0.05);
};
const PUBLIC: [string, string][] = [
	['/', '.lp-page'],
	['/changelog', '.cl-page'],
	['/privacy', '.legal-page']
];
const pageBg = (page: Page, sel: string) =>
	page.locator(sel).evaluate((e) => getComputedStyle(e).backgroundColor);
const isDark = (rgb: string) => lum(rgb) < 0.1;

for (const scheme of ['light', 'dark'] as const) {
	test.describe(`public pages, ${scheme} system`, () => {
		test.use({ colorScheme: scheme });

		test('follow the system theme', async ({ page }) => {
			for (const [path, sel] of PUBLIC) {
				await page.goto(path);
				expect(isDark(await pageBg(page, sel)), `${path} dark`).toBe(scheme === 'dark');
			}
		});

		test('changelog code is readable', async ({ page }) => {
			await page.goto('/changelog');
			const code = page.locator('.cl-body code').first();
			await expect(code).toBeVisible();
			const { color, bg } = await code.evaluate((e) => {
				const cs = getComputedStyle(e);
				return { color: cs.color, bg: cs.backgroundColor };
			});
			expect(contrast(color, bg), `code ${color} on ${bg}`).toBeGreaterThanOrEqual(4.5);
		});
	});
}

test.describe('public pages, quick switch', () => {
	test.use({ colorScheme: 'light' });

	test('the top-bar switch flips the theme, and it sticks across pages and reloads', async ({
		page
	}) => {
		await page.goto('/');
		expect(isDark(await pageBg(page, '.lp-page'))).toBe(false);
		await page.getByRole('button', { name: 'Switch to dark theme' }).click();
		expect(isDark(await pageBg(page, '.lp-page'))).toBe(true);
		await page.reload();
		expect(isDark(await pageBg(page, '.lp-page'))).toBe(true);
		for (const [path, sel] of PUBLIC.slice(1)) {
			await page.goto(path);
			expect(isDark(await pageBg(page, sel)), `${path} dark`).toBe(true);
		}
		// The same setting as the app's Appearance picker.
		await signIn(page);
		expect(await bodyBg(page)).toBe(DARK);
		await page.goto('/changelog');
		await page.getByRole('button', { name: 'Switch to light theme' }).click();
		expect(isDark(await pageBg(page, '.cl-page'))).toBe(false);
		// Back to the OS setting, not a pinned "light".
		await expect(page.locator('html')).not.toHaveAttribute('data-theme', /./);
	});
});
