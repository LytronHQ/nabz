import { test, expect } from '@playwright/test';

// /signin and /signup put PKCE_FLOW_ENCRYPTION_KEY into their page data, so the
// key was in every visitor's HTML (#580). The e2e web runs with a known value.
const KEY = process.env.E2E_PKCE_KEY || 'e2e-only-not-a-secret';

for (const path of ['/signin', '/signup']) {
	test(`${path} does not ship the encryption key`, async ({ request }) => {
		const html = await (await request.get(path)).text();
		expect(html.length).toBeGreaterThan(500);
		expect(html).not.toContain(KEY);
		expect(html).not.toMatch(/\bkey:"/);
	});
}
