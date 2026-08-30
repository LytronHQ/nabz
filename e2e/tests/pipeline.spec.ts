import { test, expect, type APIRequestContext } from '@playwright/test';

// First real end-to-end journeys (#126): drive the whole backend pipeline through
// the public API — create a monitor as the seeded dashboard user, then assert the
// REAL worker checks it and the REAL evaluator sets its status. No mocks; the only
// "fake" is the deterministic fixture target, which the worker reaches on the
// compose network at http://fixture:8080.
//
// UI (browser) journeys build on this harness in a later increment.

const PB = process.env.E2E_PB || 'http://127.0.0.1:8390';
const USER_EMAIL = process.env.E2E_USER_EMAIL || 'user@e2e.local';
const USER_PASS = process.env.E2E_USER_PASSWORD || 'e2e-user-pass';
const FIXTURE = 'http://fixture:8080';

async function auth(api: APIRequestContext) {
	const res = await api.post(`${PB}/api/collections/users/auth-with-password`, {
		data: { identity: USER_EMAIL, password: USER_PASS }
	});
	expect(res.ok(), `user auth failed: ${res.status()}`).toBeTruthy();
	const body = await res.json();
	return { token: body.token as string, userId: body.record.id as string };
}

async function createMonitor(
	api: APIRequestContext,
	token: string,
	userId: string,
	name: string,
	target: string
) {
	const res = await api.post(`${PB}/api/collections/monitors/records`, {
		headers: { Authorization: token },
		// Short interval so the worker re-checks quickly once it's seeded.
		data: { user: userId, name, type: 'website', target, interval: 30, enabled: true, status: 'pending' }
	});
	expect(res.ok(), `create monitor failed: ${res.status()} ${await res.text()}`).toBeTruthy();
	return (await res.json()).id as string;
}

async function status(api: APIRequestContext, token: string, id: string) {
	const r = await api.get(`${PB}/api/collections/monitors/records/${id}`, {
		headers: { Authorization: token }
	});
	return (await r.json()).status as string;
}

test('a healthy target goes UP through the real worker → evaluator pipeline', async ({ request }) => {
	const { token, userId } = await auth(request);
	const id = await createMonitor(request, token, userId, 'e2e up', `${FIXTURE}/status/200`);

	// The worker seeds the monitor (≤ seed interval), probes the fixture and writes
	// checks; the evaluator ticks and flips status to up. Poll, don't sleep.
	await expect
		.poll(() => status(request, token, id), { timeout: 90_000, intervals: [2000] })
		.toBe('up');

	// The worker wrote real check rows (owner can read them).
	const filter = encodeURIComponent(`monitor='${id}'`);
	const checks = await request.get(`${PB}/api/collections/checks/records?filter=${filter}`, {
		headers: { Authorization: token }
	});
	const items = (await checks.json()).items as unknown[];
	expect(items.length, 'expected at least one check row').toBeGreaterThan(0);
});

test('a failing target goes DOWN', async ({ request }) => {
	const { token, userId } = await auth(request);
	const id = await createMonitor(request, token, userId, 'e2e down', `${FIXTURE}/status/500`);

	// 5xx is unambiguously down; the evaluator needs a couple of consecutive
	// fresh failures before it opens the verdict, so allow time.
	await expect
		.poll(() => status(request, token, id), { timeout: 90_000, intervals: [2000] })
		.toBe('down');
});
