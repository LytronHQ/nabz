import { describe, it, expect } from 'vitest';
import {
	buildItems,
	overallStatus,
	publicBody,
	debugBody,
	parsePbTime,
	EVALUATOR_ZONE,
	type ZoneRow,
	WEB_ZONE
} from './health';

const NOW = Date.parse('2026-01-01T12:00:00.000Z');
const STALE_MS = 90_000;

// PocketBase-style timestamp N ms before NOW.
function pbAgo(ms: number): string {
	return new Date(NOW - ms).toISOString().replace('T', ' ');
}

const freshEval: ZoneRow = { zone: EVALUATOR_ZONE, updated: pbAgo(5_000) };
const freshZone = (z: string): ZoneRow => ({ zone: z, updated: pbAgo(5_000) });

describe('parsePbTime', () => {
	it('parses the PocketBase space-separated format', () => {
		expect(parsePbTime('2026-01-01 12:00:00.000Z')).toBe(NOW);
	});
	it('returns null for junk/empty', () => {
		expect(parsePbTime('')).toBeNull();
		expect(parsePbTime('not a date')).toBeNull();
		expect(parsePbTime(undefined)).toBeNull();
	});
});

describe('buildItems', () => {
	it('all healthy → every item ok', () => {
		const items = buildItems({
			pbReachable: true,
			rows: [freshEval, freshZone('eu'), freshZone('us')],
			now: NOW,
			staleMs: STALE_MS
		});
		expect(overallStatus(items)).toBe('ok');
		expect(items.map((i) => i.status)).toEqual(['ok', 'ok', 'ok', 'ok']);
		expect(items.map((i) => i.name).sort()).toEqual(['eu', 'evaluator', 'pocketbase', 'us']);
	});

	it('unreachable PocketBase → only the pocketbase item, degraded', () => {
		const items = buildItems({
			pbReachable: false,
			rows: [freshEval],
			now: NOW,
			staleMs: STALE_MS
		});
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({ name: 'pocketbase', status: 'unreachable' });
		expect(overallStatus(items)).toBe('degraded');
	});

	it('a missing evaluator heartbeat → evaluator stale', () => {
		const items = buildItems({
			pbReachable: true,
			rows: [freshZone('eu')],
			now: NOW,
			staleMs: STALE_MS
		});
		const ev = items.find((i) => i.name === 'evaluator');
		expect(ev?.status).toBe('stale');
		expect(overallStatus(items)).toBe('degraded');
	});

	it('an old evaluator heartbeat → stale with an age', () => {
		const items = buildItems({
			pbReachable: true,
			rows: [{ zone: EVALUATOR_ZONE, updated: pbAgo(4 * 60_000 + 2_000) }, freshZone('eu')],
			now: NOW,
			staleMs: STALE_MS
		});
		const ev = items.find((i) => i.name === 'evaluator');
		expect(ev?.status).toBe('stale');
		expect(ev?.staleForMs).toBe(4 * 60_000 + 2_000);
	});

	it('a stale worker zone → that zone stale, evaluator still ok', () => {
		const items = buildItems({
			pbReachable: true,
			rows: [freshEval, { zone: 'eu', updated: pbAgo(120_000) }, freshZone('us')],
			now: NOW,
			staleMs: STALE_MS
		});
		expect(items.find((i) => i.name === 'eu')?.status).toBe('stale');
		expect(items.find((i) => i.name === 'us')?.status).toBe('ok');
		expect(items.find((i) => i.name === 'evaluator')?.status).toBe('ok');
		expect(overallStatus(items)).toBe('degraded');
	});
});

describe('publicBody', () => {
	it('healthy → just status, no names', () => {
		const items = buildItems({
			pbReachable: true,
			rows: [freshEval, freshZone('eu')],
			now: NOW,
			staleMs: STALE_MS
		});
		expect(publicBody(items)).toEqual({ status: 'ok' });
	});

	it('degraded → names the unhealthy nodes only', () => {
		const items = buildItems({
			pbReachable: true,
			rows: [{ zone: EVALUATOR_ZONE, updated: pbAgo(300_000) }, freshZone('eu')],
			now: NOW,
			staleMs: STALE_MS
		});
		expect(publicBody(items)).toEqual({ status: 'degraded', unhealthy: ['evaluator'] });
	});
});

describe('debugBody', () => {
	// The scrubbing guarantee is structural: an item can only ever carry these keys
	// — never a worker hostname, target, or raw error (those never enter the
	// aggregator, which only sees {zone, updated}).
	const ALLOWED = new Set(['name', 'status', 'cause', 'stale_for', 'last_seen']);

	it('a stale node carries label + cause + relative stale_for + absolute last_seen', () => {
		const items = buildItems({
			pbReachable: true,
			rows: [{ zone: EVALUATOR_ZONE, updated: pbAgo(242_000) }, freshZone('eu')],
			now: NOW,
			staleMs: STALE_MS
		});
		const body = debugBody(items);
		expect(body.status).toBe('degraded');
		const ev = body.items.find((i) => i.name === 'evaluator')!;
		expect(ev.status).toBe('stale');
		expect(ev.cause).toBe('no recent heartbeat within the staleness window');
		expect(ev.stale_for).toBe('4m2s'); // relative, humanized — not a raw ms count
		expect(ev.last_seen).toBe(pbAgo(242_000)); // absolute — pins when it went silent
		expect(JSON.stringify(body)).not.toContain('242000');
	});

	it('every item exposes only the allowed keys (no host/raw fields leak)', () => {
		const items = buildItems({
			pbReachable: true,
			rows: [{ zone: EVALUATOR_ZONE, updated: pbAgo(300_000) }, freshZone('eu')],
			now: NOW,
			staleMs: STALE_MS
		});
		for (const it of debugBody(items).items) {
			for (const k of Object.keys(it)) expect(ALLOWED.has(k)).toBe(true);
		}
	});

	it('a healthy node still reports last_seen, but no cause or stale_for', () => {
		const items = buildItems({
			pbReachable: true,
			rows: [freshEval, freshZone('eu')],
			now: NOW,
			staleMs: STALE_MS
		});
		const eu = debugBody(items).items.find((i) => i.name === 'eu')!;
		expect(eu.status).toBe('ok');
		expect(eu.cause).toBeUndefined();
		expect(eu.stale_for).toBeUndefined();
		expect(eu.last_seen).toBe(freshZone('eu').updated);
		// PocketBase has no heartbeat row → no last_seen.
		expect(debugBody(items).items.find((i) => i.name === 'pocketbase')!.last_seen).toBeUndefined();
	});
});

describe('web path liveness (#339)', () => {
	const now = Date.parse('2026-08-23T12:00:00Z');
	const at = (msAgo: number) =>
		new Date(now - msAgo).toISOString().replace('T', ' ').replace('Z', 'Z');

	it('reports the web row as its own item, not as a probe zone', () => {
		const items = buildItems({
			pbReachable: true,
			rows: [
				{ zone: EVALUATOR_ZONE, updated: at(1000) },
				{ zone: WEB_ZONE, updated: at(1000) },
				{ zone: 'eu-central', updated: at(1000) }
			],
			now,
			staleMs: 90_000
		});
		expect(items.find((i) => i.name === 'web')?.kind).toBe('web');
		// Only the real probe zone may be listed as one — otherwise the reserved
		// liveness rows show up in the fleet as if they were regions.
		expect(items.filter((i) => i.kind === 'zone').map((i) => i.name)).toEqual(['eu-central']);
	});

	it('degrades when the check-in path beat is stale', () => {
		const items = buildItems({
			pbReachable: true,
			rows: [
				{ zone: EVALUATOR_ZONE, updated: at(1000) },
				{ zone: WEB_ZONE, updated: at(10 * 60 * 1000) }
			],
			now,
			staleMs: 90_000
		});
		expect(items.find((i) => i.name === 'web')?.status).toBe('stale');
		expect(overallStatus(items)).toBe('degraded');
	});

	it('omits the beat entirely until it has run once', () => {
		// Absent means the Cron Trigger is not deployed, not that the path is
		// broken. Reporting it stale would put every environment without the cron
		// permanently in `degraded` — and would disagree with the evaluator, which
		// treats an absent beat as healthy so alerting keeps working.
		const items = buildItems({
			pbReachable: true,
			rows: [{ zone: EVALUATOR_ZONE, updated: at(1000) }],
			now,
			staleMs: 90_000
		});
		expect(items.find((i) => i.name === 'web')).toBeUndefined();
		expect(overallStatus(items)).toBe('ok');
	});
});

describe('the web beat gets its own staleness window (#339 cadence)', () => {
	const now = Date.parse('2026-08-23T21:10:00.000Z');
	const beat = (agoMs: number) => ({
		zone: 'web',
		updated: new Date(now - agoMs).toISOString().replace('T', ' ')
	});

	it('a 100s-old beat is healthy — the cron only fires every 120s', () => {
		// Under the shared 90s window this read as stale, so a punctual beat made
		// the endpoint report degraded for the last 30s of every cycle.
		const items = buildItems({
			pbReachable: true,
			rows: [beat(100_000)],
			now,
			staleMs: 90_000,
			webStaleMs: 300_000
		});
		expect(items.find((i) => i.name === 'web')?.status).toBe('ok');
	});

	it('a genuinely dead beat still goes stale', () => {
		const items = buildItems({
			pbReachable: true,
			rows: [beat(400_000)],
			now,
			staleMs: 90_000,
			webStaleMs: 300_000
		});
		expect(items.find((i) => i.name === 'web')?.status).toBe('stale');
	});

	it('zone heartbeats keep the short window — they beat every 10s', () => {
		// The whole point of separating them: a dead worker must not be masked by
		// the web beat's much longer window.
		const items = buildItems({
			pbReachable: true,
			rows: [{ zone: 'eu-central', updated: new Date(now - 100_000).toISOString().replace('T', ' ') }],
			now,
			staleMs: 90_000,
			webStaleMs: 300_000
		});
		expect(items.find((i) => i.name === 'eu-central')?.status).toBe('stale');
	});
});
