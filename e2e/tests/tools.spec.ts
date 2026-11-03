import { test, expect, type Page } from '@playwright/test';
import { signIn } from './helpers';

// The free check tools (#684). Globalping is mocked here: the page calls it from
// the browser, so page.route sees every request, and a mock keeps the run fast and
// off the real probes' quota.

const API = 'https://api.globalping.io/v1/measurements';

type Result = Record<string, unknown>;
async function mockGlobalping(page: Page, results: Result[], seen: object[] = []) {
	await page.route(API, async (route) => {
		seen.push(route.request().postDataJSON());
		await route.fulfill({ status: 202, json: { id: 'mock1' } });
	});
	await page.route(`${API}/mock1`, (route) =>
		route.fulfill({
			json: {
				id: 'mock1',
				status: 'finished',
				results: results.map((result, i) => ({
					probe: { city: ['Frankfurt', 'Singapore', 'Dallas'][i], country: ['DE', 'SG', 'US'][i] },
					result
				}))
			}
		})
	);
	return seen;
}

test('the website check shows each probe and leads into the free trial', async ({ page }) => {
	const seen = await mockGlobalping(page, [
		{ status: 'finished', statusCode: 200, timings: { total: 120 } },
		{ status: 'finished', statusCode: 200, timings: { total: 310 } }
	]);
	await page.goto('/tools');
	await page.getByRole('link', { name: /Website check/ }).click();
	await expect(page.getByRole('heading', { name: 'Is this website up?', level: 1 })).toBeVisible();
	await page.getByLabel('URL').fill('example.com');
	await page.getByRole('button', { name: 'Check' }).click();

	await expect(page.getByRole('heading', { name: 'Up from all 2 places' })).toBeVisible();
	await expect(page.getByText('Frankfurt, DE')).toBeVisible();
	await expect(page.getByText('HTTP 200 · 310 ms')).toBeVisible();
	expect(seen[0]).toMatchObject({ type: 'http', target: 'example.com' });

	await page.getByRole('link', { name: 'Watch this free, no sign-up' }).click();
	await expect(page).toHaveURL(/\/\?url=https%3A%2F%2Fexample\.com%2F#try$/);
	await expect(page.getByLabel('URL to monitor')).toHaveValue('https://example.com/');
});

test('the port check refuses an uncommon port without calling Globalping', async ({ page }) => {
	const seen = await mockGlobalping(page, []);
	await page.goto('/tools/port');
	await page.getByLabel('Host and port').fill('example.com:31337');
	await page.getByRole('button', { name: 'Check' }).click();
	await expect(page.getByRole('alert')).toContainText('common service ports');
	expect(seen).toHaveLength(0);
});

test('a used-up Globalping quota is explained', async ({ page }) => {
	await page.route(API, (route) => route.fulfill({ status: 429, json: {} }));
	await page.goto('/tools/ping');
	await page.getByLabel('Host').fill('example.com');
	await page.getByRole('button', { name: 'Check' }).click();
	await expect(page.getByRole('alert')).toContainText('free Globalping checks for this hour');
});

test('signed in, "watch this" opens a prefilled port monitor', async ({ page }) => {
	await signIn(page);
	await mockGlobalping(page, [{ status: 'finished', stats: { avg: 18, loss: 0 } }]);
	await page.goto('/tools/port');
	// The tools are public pages: no app shell, even signed in.
	await expect(page.getByRole('link', { name: 'Dashboard' })).toHaveCount(0);
	await page.getByLabel('Host and port').fill('example.com:443');
	await page.getByRole('button', { name: 'Check' }).click();
	await expect(page.getByRole('heading', { name: 'Open from 1 of 1 place' })).toBeVisible();
	await page.getByRole('link', { name: /Watch this every few minutes/ }).click();
	await expect(page).toHaveURL(/\/monitors\/new\?type=port&target=example\.com%3A443$/);
	await expect(page.getByLabel('Host:Port', { exact: true })).toHaveValue('example.com:443');
});

test('an unknown tool is a 404', async ({ page }) => {
	const res = await page.goto('/tools/nope');
	expect(res?.status()).toBe(404);
});
