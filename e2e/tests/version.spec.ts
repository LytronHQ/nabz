import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { signIn } from './helpers';

// "Which web build is live?" had no answer: the nodes print their version, the
// web printed nothing (#489). The version is the repo-root VERSION file.
const VERSION = readFileSync(join(__dirname, '../../VERSION'), 'utf8').trim();
const LABEL = new RegExp(`^v${VERSION.replace(/\./g, '\\.')}( \\([0-9a-f]{7}\\))?$`);

test('/api/health reports the web version', async ({ request }) => {
	const res = await request.get('/api/health');
	const body = await res.json();
	expect(body.version).toBe(VERSION);
	expect(typeof body.commit).toBe('string');
});

test('the landing footer and the signed-in sidebar show the build', async ({ page }) => {
	await page.goto('/');
	await expect(page.locator('.lp-footer')).toContainText(`v${VERSION}`);
	await signIn(page);
	await expect(page.locator('.side__ver')).toHaveText(LABEL);
});
