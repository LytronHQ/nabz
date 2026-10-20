import { test, expect, type APIRequestContext } from '@playwright/test';

// "Is it us?" (#598), through the real worker and evaluator. When a check fails
// and the worker's own canary fails too, the failure is the worker's network,
// not the site: the check is stored inconclusive, opens no incident, and does not
// count against uptime. With the canary healthy, the same failure is the site's
// and goes down as before.

const PB = process.env.E2E_PB || 'http://127.0.0.1:8390';
const FIXTURE_HOST = process.env.E2E_FIXTURE || 'http://127.0.0.1:8788';
const USER_EMAIL = process.env.E2E_USER_EMAIL || 'user@e2e.local';
const USER_PASS = process.env.E2E_USER_PASSWORD || 'e2e-user-pass';

async function auth(api: APIRequestContext) {
	const res = await api.post(`${PB}/api/collections/users/auth-with-password`, {
		data: { identity: USER_EMAIL, password: USER_PASS }
	});
	expect(res.ok()).toBeTruthy();
	const b = await res.json();
	return { token: b.token as string, userId: b.record.id as string };
}

const canary = (api: APIRequestContext, state: 'down' | 'up') =>
	api.post(`${FIXTURE_HOST}/canary/${state}`);

test.afterEach(async ({ request }) => {
	// Never leave the stack's only canary down for the specs after this one.
	await canary(request, 'up');
});

test('a failure while the worker cannot reach its canary is not counted, and opens no incident', async ({
	request
}) => {
	test.setTimeout(240_000);
	const { token, userId } = await auth(request);
	const headers = { Authorization: token };
	expect((await canary(request, 'down')).ok()).toBeTruthy();

	const created = await request.post(`${PB}/api/collections/monitors/records`, {
		headers,
		data: {
			user: userId,
			name: 'e2e zone fault (test monitor, DOWN on purpose)',
			type: 'website',
			target: 'http://fixture:8080/status/500',
			interval: 30,
			enabled: true,
			status: 'pending'
		}
	});
	expect(created.ok()).toBeTruthy();
	const id = (await created.json()).id as string;
	try {
		const checks = async () =>
			(
				await (
					await request.get(
						`${PB}/api/collections/checks/records?perPage=50&sort=checked_at&filter=${encodeURIComponent(`monitor = "${id}"`)}`,
						{ headers }
					)
				).json()
			).items as { up: boolean; inconclusive: boolean; error: string }[];

		// Enough failed checks that, counted, they would have opened an incident.
		await expect
			.poll(async () => (await checks()).length, { timeout: 120_000 })
			.toBeGreaterThanOrEqual(3);
		const before = await checks();
		for (const c of before) {
			expect(c).toMatchObject({ up: false, inconclusive: true });
			expect(c.error).toContain('not counted');
		}
		const monitor = await (
			await request.get(`${PB}/api/collections/monitors/records/${id}`, { headers })
		).json();
		expect(monitor.status).not.toBe('down');
		const incidents = await (
			await request.get(
				`${PB}/api/collections/incidents/records?filter=${encodeURIComponent(`monitor = "${id}"`)}`,
				{ headers }
			)
		).json();
		expect(incidents.totalItems).toBe(0);

		// The worker's network is back: the very same failure is now the site's.
		await canary(request, 'up');
		await expect
			.poll(
				async () =>
					(
						await (
							await request.get(`${PB}/api/collections/monitors/records/${id}`, { headers })
						).json()
					).status,
				{ timeout: 120_000, intervals: [2000] }
			)
			.toBe('down');
		const after = await checks();
		expect(after.some((c) => !c.up && !c.inconclusive)).toBe(true);
	} finally {
		await request.delete(`${PB}/api/collections/monitors/records/${id}`, { headers });
	}
});
