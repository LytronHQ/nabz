import { test, expect, type APIRequestContext } from '@playwright/test';
import { signIn, USER, PASS } from './helpers';

// Incident lifecycle BROWSER journey (#126): a monitor goes down → the REAL
// evaluator opens an incident → the monitor recovers → the evaluator resolves
// it, with the incidents UI reflecting each phase. Monitor create/edit is driven
// through the API for determinism; the assertions are the real pipeline + the UI.
const PB = process.env.E2E_PB || 'http://127.0.0.1:8390';
const FIXTURE = 'http://fixture:8080';

async function authApi(request: APIRequestContext) {
	const res = await request.post(`${PB}/api/collections/users/auth-with-password`, {
		data: { identity: USER, password: PASS }
	});
	expect(res.ok(), `user auth failed: ${res.status()}`).toBeTruthy();
	const b = await res.json();
	return { token: b.token as string, userId: b.record.id as string };
}

async function incidentCount(
	request: APIRequestContext,
	token: string,
	monitorId: string,
	state: 'open' | 'resolved'
) {
	const cond = state === 'open' ? `resolved_at=''` : `resolved_at!=''`;
	const filter = encodeURIComponent(`monitor='${monitorId}' && ${cond}`);
	const res = await request.get(`${PB}/api/collections/incidents/records?filter=${filter}`, {
		headers: { Authorization: token }
	});
	return (((await res.json()).items ?? []) as unknown[]).length;
}

test('a down monitor opens an incident, then recovers and resolves it', async ({ page, request }) => {
	// The full down → open → recover → resolve loop spans several evaluator ticks.
	test.setTimeout(200_000);

	const { token, userId } = await authApi(request);
	// Unique per attempt so a retry (or an earlier spec) never collides on the
	// incident card's monitor-name heading.
	const name = `e2e-incident-${Date.now()}`;

	// A monitor pointed at a failing target.
	const create = await request.post(`${PB}/api/collections/monitors/records`, {
		headers: { Authorization: token },
		data: {
			user: userId,
			name,
			type: 'website',
			target: `${FIXTURE}/status/500`,
			interval: 30,
			enabled: true,
			status: 'pending'
		}
	});
	expect(create.ok(), `create monitor: ${await create.text()}`).toBeTruthy();
	const id = (await create.json()).id as string;

	// The evaluator opens an incident once the monitor is confirmed down.
	await expect
		.poll(() => incidentCount(request, token, id, 'open'), { timeout: 100_000, intervals: [2000] })
		.toBeGreaterThan(0);

	// The incidents UI shows it as an ongoing incident for this monitor.
	await signIn(page);
	await page.goto('/incidents?filter=open');
	await expect(page.getByRole('heading', { name }).first()).toBeVisible();

	// Recover: point it at a healthy target; the evaluator resolves the incident.
	const patch = await request.patch(`${PB}/api/collections/monitors/records/${id}`, {
		headers: { Authorization: token },
		data: { target: `${FIXTURE}/status/200` }
	});
	expect(patch.ok()).toBeTruthy();

	await expect
		.poll(() => incidentCount(request, token, id, 'resolved'), { timeout: 100_000, intervals: [2000] })
		.toBeGreaterThan(0);
	await expect
		.poll(() => incidentCount(request, token, id, 'open'), { timeout: 30_000, intervals: [2000] })
		.toBe(0);

	// The UI now lists it under Resolved.
	await page.goto('/incidents?filter=resolved');
	await expect(page.getByRole('heading', { name }).first()).toBeVisible();
});
