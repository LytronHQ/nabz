import { test, expect, type Page } from '@playwright/test';
import { signIn } from './helpers';

// /admin/usage had never been opened by a test: the e2e web listed no admins.
// Found once it was: "Total users 0" beside "Active users 1" (the e2e stack
// lacked the users.listRule every real environment sets), and the "not enough
// history yet" note wrapping over the big number on the checks card.

const ADMIN = process.env.E2E_ADMIN_EMAIL || 'staff@e2e.local';
const ADMIN_PASS = process.env.E2E_ADMIN_PASSWORD || 'e2e-staff-pass';

async function signInAdmin(page: Page) {
	await page.goto('/signin');
	await page.getByLabel('Email', { exact: true }).fill(ADMIN);
	await page.getByLabel('Password').fill(ADMIN_PASS);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL(/\/dashboard/);
}

const stat = (page: Page, label: string) =>
	page.locator('.stat').filter({ has: page.locator('.label', { hasText: label }) });

test('an ordinary user has no Usage link and gets a 404', async ({ page }) => {
	await signIn(page);
	await expect(page.getByRole('link', { name: 'Usage' })).toHaveCount(0);
	const res = await page.goto('/admin/usage');
	expect(res?.status()).toBe(404);
});

test('an admin reaches Usage from the nav, and its user counts add up', async ({ page }) => {
	await signInAdmin(page);
	await page.getByRole('link', { name: 'Usage' }).click();
	await expect(page).toHaveURL(/\/admin\/usage$/);
	const total = Number(await stat(page, 'Total users').locator('.value').innerText());
	const active = Number(await stat(page, 'Active users').locator('.value').innerText());
	// setup.sh seeds two users; the e2e user owns monitors.
	expect(total).toBeGreaterThanOrEqual(2);
	expect(active).toBeGreaterThanOrEqual(1);
	expect(total, 'total users >= active users').toBeGreaterThanOrEqual(active);
});

test('phone width: no caption overlaps its stat value', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await signInAdmin(page);
	await page.goto('/admin/usage');
	const clashes = await page.locator('.stat').evaluateAll((cards) =>
		cards.flatMap((c) => {
			const v = c.querySelector('.value')?.getBoundingClientRect();
			if (!v) return [];
			return [...c.querySelectorAll('.delta, .spark')]
				.map((d) => d.getBoundingClientRect())
				.filter((d) => d.left < v.right && v.left < d.right && d.top < v.bottom && v.top < d.bottom)
				.map(() => c.querySelector('.label')?.textContent?.trim() ?? '?');
		})
	);
	expect(clashes).toEqual([]);
});

// The checks sparkline was drawn in --accent on the brand-filled emphasis card,
// which in light mode is nearly the same colour: present, and invisible (#568).
for (const scheme of ['light', 'dark'] as const) {
	test(`${scheme}: the checks sparkline stands out from its card`, async ({ page }) => {
		await page.emulateMedia({ colorScheme: scheme });
		await signInAdmin(page);
		await page.goto('/admin/usage');
		const card = page.locator('.stat', { hasText: 'Checks · latest day' });
		await expect(card.locator('.spark path')).toHaveCount(1);
		const [line, bg] = await card.evaluate((c) => [
			getComputedStyle(c.querySelector('.spark path')!).stroke,
			getComputedStyle(c).backgroundColor
		]);
		const rgb = (s: string) => (s.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
		const lum = (s: string) => {
			const [r, g, b] = rgb(s).map((v) => {
				const c = v / 255;
				return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
			});
			return 0.2126 * r + 0.7152 * g + 0.0722 * b;
		};
		const [hi, lo] = [lum(line), lum(bg)].sort((a, b) => b - a);
		// 3:1 is WCAG's floor for graphics that carry meaning.
		expect((hi + 0.05) / (lo + 0.05), `${line} on ${bg}`).toBeGreaterThanOrEqual(3);
	});
}
