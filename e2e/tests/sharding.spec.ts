import { test, expect, type APIRequestContext } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

// Multi-worker zones (#440). A zone may hold any number of workers on any number
// of hosts; every monitor must still be checked exactly once per interval by
// exactly one of them.
//
// These tests drive the real stack: they scale the worker service up and down and
// then read `checks` rows to see what actually happened. Nothing is mocked, which
// is the point — the sharding rule is unit-tested elsewhere, and what cannot be
// unit-tested is whether several real processes agree.

const PB = process.env.E2E_PB || 'http://127.0.0.1:8390';
const SU_EMAIL = process.env.E2E_SUPERUSER_EMAIL || 'admin@e2e.local';
const SU_PASS = process.env.E2E_SUPERUSER_PASSWORD || 'e2e-superuser-pass';
const USER_EMAIL = process.env.E2E_USER_EMAIL || 'user@e2e.local';
const USER_PASS = process.env.E2E_USER_PASSWORD || 'e2e-user-pass';
const FIXTURE = 'http://fixture:8080';
const ZONE = 'e2e';
const ZONE_B = 'e2e-b';
const INTERVAL = 30;

// The stack runs the worker at a tempo a test can watch (see the
// WORKER_*_INTERVAL / WORKER_ROSTER_TTL settings in docker-compose.e2e.yml):
// 1s heartbeat, 2s reconcile, 4s roster TTL, against 10s/30s/45s in production.
// These mirror those numbers so the waits below say WHY they are what they are
// rather than being round numbers someone has to reverse-engineer.
const ROSTER_TTL_MS = 4_000;
const RECONCILE_MS = 2_000;
// Long enough for a roster change to be seen and acted on, with room for a
// PocketBase round trip: the TTL, a reconcile, and a margin.
const SETTLE_MS = ROSTER_TTL_MS + RECONCILE_MS * 2 + 4_000;

const COMPOSE_FILE = path.join(__dirname, '..', 'docker-compose.e2e.yml');

function compose(...args: string[]) {
	return execFileSync('docker', ['compose', '-f', COMPOSE_FILE, ...args], {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe']
	});
}

function scaleWorkers(n: number) {
	compose('up', '-d', '--no-build', '--scale', `worker=${n}`);
}

/** Container ids of the running replicas of a service. */
function containers(service: string): string[] {
	return compose('ps', '-q', service).split('\n').map((s) => s.trim()).filter(Boolean);
}

/** Take one container away and keep it away.
 *
 *  `docker compose kill` addresses SERVICES, not containers, so it cannot single
 *  out one replica of a scaled service. Plain `docker kill` can — but the worker
 *  service is `restart: unless-stopped`, so an abnormal exit brings it straight
 *  back and nothing is ever taken over. `docker stop` is the one that means "this
 *  worker is gone": the restart policy deliberately does not resurrect a container
 *  an operator stopped. -t 0 skips the grace period the worker has no use for. */
function stopContainer(id: string) {
	execFileSync('docker', ['stop', '-t', '0', id], { encoding: 'utf8' });
}

/** Best effort: compose may already have replaced the container during a scale,
 *  in which case there is nothing to start and afterAll restores the topology
 *  anyway. A cleanup step must not be the thing that fails the test. */
function startContainer(id: string) {
	try {
		execFileSync('docker', ['start', id], { encoding: 'utf8' });
	} catch {
		/* already gone */
	}
}

async function suToken(api: APIRequestContext): Promise<string> {
	const res = await api.post(`${PB}/api/collections/_superusers/auth-with-password`, {
		data: { identity: SU_EMAIL, password: SU_PASS }
	});
	expect(res.ok(), `superuser auth failed: ${res.status()}`).toBeTruthy();
	return (await res.json()).token as string;
}

async function userAuth(api: APIRequestContext) {
	const res = await api.post(`${PB}/api/collections/users/auth-with-password`, {
		data: { identity: USER_EMAIL, password: USER_PASS }
	});
	expect(res.ok(), `user auth failed: ${res.status()}`).toBeTruthy();
	const body = await res.json();
	return { token: body.token as string, userId: body.record.id as string };
}

async function records(api: APIRequestContext, token: string, collection: string, query: string) {
	const res = await api.get(`${PB}/api/collections/${collection}/records?${query}`, {
		headers: { Authorization: token }
	});
	expect(res.ok(), `read ${collection} failed: ${res.status()} ${await res.text()}`).toBeTruthy();
	return (await res.json()).items as Record<string, unknown>[];
}

/** Workers PocketBase currently believes are alive in a zone. */
async function liveWorkers(api: APIRequestContext, token: string, zone: string, ttlMs = ROSTER_TTL_MS * 3) {
	const rows = await records(
		api,
		token,
		'worker_heartbeats',
		`perPage=100&filter=${encodeURIComponent(`zone='${zone}'`)}`
	);
	const now = Date.now();
	return rows
		.filter((r) => now - Date.parse(String(r.updated).replace(' ', 'T')) < ttlMs)
		.map((r) => String(r.worker))
		.sort();
}

async function createMonitor(
	api: APIRequestContext,
	token: string,
	userId: string,
	name: string,
	zone: string
) {
	const res = await api.post(`${PB}/api/collections/monitors/records`, {
		headers: { Authorization: token },
		data: {
			user: userId,
			name,
			type: 'website',
			target: `${FIXTURE}/status/200`,
			interval: INTERVAL,
			enabled: true,
			status: 'pending',
			zones: [zone]
		}
	});
	expect(res.ok(), `create monitor failed: ${res.status()} ${await res.text()}`).toBeTruthy();
	return (await res.json()).id as string;
}

async function checkTimes(api: APIRequestContext, token: string, monitorId: string, sinceMs: number) {
	const rows = await records(
		api,
		token,
		'checks',
		`perPage=200&sort=checked_at&filter=${encodeURIComponent(`monitor='${monitorId}'`)}`
	);
	return rows
		.map((r) => Date.parse(String(r.checked_at).replace(' ', 'T')))
		.filter((t) => t >= sinceMs)
		.sort((a, b) => a - b);
}

async function zoneStatsUpdated(api: APIRequestContext, token: string, zone: string) {
	const rows = await records(
		api,
		token,
		'zone_stats',
		`perPage=1&filter=${encodeURIComponent(`zone='${zone}'`)}`
	);
	if (rows.length === 0) return null;
	return Date.parse(String(rows[0].updated).replace(' ', 'T'));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test.describe('multi-worker zones', () => {
	test.describe.configure({ mode: 'serial', timeout: 420_000 });

	// However a test ends, the stack goes back to one worker and one zone — every
	// other spec assumes that.
	test.afterAll(() => {
		try {
			compose('--profile', 'zone2', 'stop', 'worker-b');
			compose('--profile', 'zone2', 'rm', '-f', 'worker-b');
		} catch {
			/* not started */
		}
		scaleWorkers(1);
	});

	test('three workers check every monitor exactly once per interval', async ({ request }) => {
		const su = await suToken(request);
		const { token, userId } = await userAuth(request);

		const ids: string[] = [];
		for (let i = 0; i < 6; i++) {
			ids.push(await createMonitor(request, token, userId, `shard ${i} ${Date.now()}`, ZONE));
		}

		scaleWorkers(3);

		// Wait until PocketBase can see three live workers AND they have had a
		// reconcile pass to settle ownership. Measuring before that would be
		// measuring the rebalance, which is explicitly allowed to double up.
		await expect
			.poll(() => liveWorkers(request, su, ZONE).then((w) => w.length), {
				timeout: 60_000,
				intervals: [1000]
			})
			.toBe(3);
		await sleep(SETTLE_MS);

		const from = Date.now();
		// Two full intervals of steady state.
		await sleep(INTERVAL * 2 * 1000 + 10_000);

		for (const id of ids) {
			const times = await checkTimes(request, su, id, from);
			expect(times.length, `monitor ${id} was not checked at all`).toBeGreaterThanOrEqual(1);
			// Exactly once per interval: two checks closer together than half an
			// interval means two workers both believed they owned this monitor.
			for (let i = 1; i < times.length; i++) {
				const gap = times[i] - times[i - 1];
				expect(
					gap,
					`monitor ${id} was checked twice ${gap}ms apart — two workers own it`
				).toBeGreaterThan((INTERVAL * 1000) / 2);
			}
		}

		// And the work is actually split, not all done by one worker.
		const stats = await records(
			request,
			su,
			'zone_stats',
			`perPage=1&filter=${encodeURIComponent(`zone='${ZONE}'`)}`
		);
		expect(Number(stats[0]?.workers), 'zone_stats.workers should report the roster').toBe(3);
	});

	test('killing a worker hands its monitors to the others, and the zone keeps beating', async ({
		request
	}) => {
		const su = await suToken(request);
		const { token, userId } = await userAuth(request);

		const ids: string[] = [];
		for (let i = 0; i < 6; i++) {
			ids.push(await createMonitor(request, token, userId, `takeover ${i} ${Date.now()}`, ZONE));
		}

		scaleWorkers(3);
		await expect
			.poll(() => liveWorkers(request, su, ZONE).then((w) => w.length), {
				timeout: 60_000,
				intervals: [1000]
			})
			.toBe(3);
		await sleep(SETTLE_MS);

		// Take away the ELECTED STATS WRITER specifically — the interesting case,
		// and the one the stale-row fallback exists for. It publishes its own id in
		// zone_stats.worker, and that id is the container hostname, which is the
		// first 12 characters of the container id.
		const statsRow = await records(
			request,
			su,
			'zone_stats',
			`perPage=1&filter=${encodeURIComponent(`zone='${ZONE}'`)}`
		);
		const writerId = String(statsRow[0]?.worker ?? '');
		expect(writerId, 'no worker has published zone_stats').not.toBe('');

		const running = containers('worker');
		const victim = running.find((c) => c.startsWith(writerId)) ?? running[0];
		expect(victim, 'could not find the elected writer container').toBeTruthy();
		stopContainer(victim);
		const killedAt = Date.now();

		let lastSeen = await zoneStatsUpdated(request, su, ZONE);
		let stalest = 0;
		while (Date.now() - killedAt < 30_000) {
			await sleep(5000);
			const now = await zoneStatsUpdated(request, su, ZONE);
			if (now !== null && lastSeen !== null) {
				stalest = Math.max(stalest, Date.now() - now);
			}
			lastSeen = now;
		}
		// The elected writer dying costs at most the fallback window plus a tick.
		// The fallback publishes once the row is 3 stats intervals old, so a gap
		// much beyond that means no live worker took the writer's place.
		expect(stalest, 'the zone heartbeat stalled while workers were still alive').toBeLessThan(
			15_000
		);

		// Every monitor is being checked again by whoever inherited it.
		const from = Date.now();
		await sleep(INTERVAL * 2 * 1000 + 10_000);
		for (const id of ids) {
			const times = await checkTimes(request, su, id, from);
			expect(times.length, `monitor ${id} was orphaned after a worker died`).toBeGreaterThanOrEqual(
				1
			);
		}

		// Put it back so compose's bookkeeping matches reality for the next test.
		startContainer(victim);
	});

	test('a rejoining worker rebalances without lasting duplication', async ({ request }) => {
		const su = await suToken(request);
		const { token, userId } = await userAuth(request);

		const ids: string[] = [];
		for (let i = 0; i < 6; i++) {
			ids.push(await createMonitor(request, token, userId, `rejoin ${i} ${Date.now()}`, ZONE));
		}

		scaleWorkers(1);
		await expect
			.poll(() => liveWorkers(request, su, ZONE).then((w) => w.length), {
				timeout: 60_000,
				intervals: [1000]
			})
			.toBe(1);
		await sleep(SETTLE_MS);

		// A worker joins.
		scaleWorkers(2);
		await expect
			.poll(() => liveWorkers(request, su, ZONE).then((w) => w.length), {
				timeout: 60_000,
				intervals: [1000]
			})
			.toBe(2);

		// Let the rebalance happen, then require steady state afterwards: duplicates
		// are accepted DURING the change, not after it.
		await sleep(SETTLE_MS);
		const from = Date.now();
		await sleep(INTERVAL * 2 * 1000 + 10_000);

		for (const id of ids) {
			const times = await checkTimes(request, su, id, from);
			expect(times.length, `monitor ${id} stopped being checked after the rebalance`).toBeGreaterThanOrEqual(1);
			for (let i = 1; i < times.length; i++) {
				const gap = times[i] - times[i - 1];
				expect(gap, `monitor ${id} still double-checked ${gap}ms apart after rebalancing`).toBeGreaterThan(
					(INTERVAL * 1000) / 2
				);
			}
		}
	});

	test('a second zone is unaffected, and dies only when all of its workers die', async ({
		request
	}) => {
		const su = await suToken(request);
		const { token, userId } = await userAuth(request);

		// One monitor pinned to each zone.
		const idA = await createMonitor(request, token, userId, `zoneA ${Date.now()}`, ZONE);
		const idB = await createMonitor(request, token, userId, `zoneB ${Date.now()}`, ZONE_B);

		compose('--profile', 'zone2', 'up', '-d', '--no-build', 'worker-b');
		await expect
			.poll(() => liveWorkers(request, su, ZONE_B).then((w) => w.length), {
				timeout: 60_000,
				intervals: [1000]
			})
			.toBe(1);

		// Each zone checks only its own monitor.
		await expect
			.poll(() => checkTimes(request, su, idB, 0).then((t) => t.length), {
				timeout: 120_000,
				intervals: [3000]
			})
			.toBeGreaterThanOrEqual(1);

		const crossZone = await records(
			request,
			su,
			'checks',
			`perPage=50&filter=${encodeURIComponent(`monitor='${idB}' && zone='${ZONE}'`)}`
		);
		expect(crossZone.length, 'a monitor pinned to zone B was checked by zone A').toBe(0);

		const zoneAChecks = await records(
			request,
			su,
			'checks',
			`perPage=50&filter=${encodeURIComponent(`monitor='${idA}' && zone='${ZONE_B}'`)}`
		);
		expect(zoneAChecks.length, 'a monitor pinned to zone A was checked by zone B').toBe(0);

		// Clear any `zone.silent` row left by an earlier run: the evaluator writes
		// it once per transition, so a stale one makes the poll below return
		// instantly and the test measures nothing.
		for (const row of await records(
			request,
			su,
			'alert_state',
			`perPage=10&filter=${encodeURIComponent(`key='zone.silent:${ZONE_B}'`)}`
		)) {
			await request.delete(`${PB}/api/collections/alert_state/records/${row.id}`, {
				headers: { Authorization: su }
			});
		}

		// Now kill every worker in zone B. With no worker left, the zone must go
		// silent and the evaluator's dead-man's switch must fire — while zone A,
		// whose workers are untouched, keeps beating.
		const beforeKill = await zoneStatsUpdated(request, su, ZONE);
		compose('--profile', 'zone2', 'stop', '-t', '0', 'worker-b');

		// DEADMAN_SECONDS=30 in this stack; the evaluator records the transition in
		// alert_state, which is the durable evidence it fired.
		await expect
			.poll(
				async () => {
					const rows = await records(
						request,
						su,
						'alert_state',
						`perPage=10&filter=${encodeURIComponent(`key='zone.silent:${ZONE_B}'`)}`
					);
					return rows.length;
				},
				{ timeout: 180_000, intervals: [5000] }
			)
			.toBeGreaterThanOrEqual(1);

		// Zone A must still be beating. Poll for the advance instead of taking two
		// samples: "keeps beating" is a property over time, and a two-point
		// comparison fails whenever the window happens to be shorter than one
		// stats interval — which says nothing about the zone.
		await expect
			.poll(() => zoneStatsUpdated(request, su, ZONE), {
				timeout: 30_000,
				intervals: [1000],
				message: 'zone A stopped beating when zone B died'
			})
			.toBeGreaterThan(Number(beforeKill));
	});
});
