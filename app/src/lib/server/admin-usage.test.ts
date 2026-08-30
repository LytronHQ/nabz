import { describe, it, expect } from 'vitest';
import { distinctCount, countBy, checksPerDay, getFleetOps } from './admin-usage';

describe('distinctCount', () => {
	it('counts distinct non-empty values of a field', () => {
		const rows = [{ user: 'a' }, { user: 'b' }, { user: 'a' }, { user: '' }, {}];
		expect(distinctCount(rows, 'user')).toBe(2);
	});
	it('is 0 for no rows', () => {
		expect(distinctCount([], 'user')).toBe(0);
	});
});

describe('countBy', () => {
	it('groups and counts by a field value', () => {
		const rows = [{ type: 'email' }, { type: 'slack' }, { type: 'email' }, { type: '' }];
		expect(countBy(rows, 'type')).toEqual({ email: 2, slack: 1 });
	});
});

describe('checksPerDay', () => {
	it('sums check_count by day across monitors, oldest→newest', () => {
		const rows = [
			{ bucket_start: '2026-08-02 00:00:00.000Z', check_count: 10 },
			{ bucket_start: '2026-08-01 00:00:00.000Z', check_count: 5 },
			{ bucket_start: '2026-08-02 00:00:00.000Z', check_count: 7 }, // same day, another monitor
			{ bucket_start: '2026-08-01 00:00:00.000Z', check_count: 3 }
		];
		expect(checksPerDay(rows)).toEqual([
			{ day: '2026-08-01', checks: 8 },
			{ day: '2026-08-02', checks: 17 }
		]);
	});
	it('ignores rows with no bucket_start and treats missing counts as 0', () => {
		const rows = [{ bucket_start: '2026-08-01 00:00:00.000Z' }, { check_count: 9 }];
		expect(checksPerDay(rows)).toEqual([{ day: '2026-08-01', checks: 0 }]);
	});
});

describe('getFleetOps live worker count (#311)', () => {
	const pbWith = (rows: Record<string, unknown>[]) =>
		({ collection: () => ({ getFullList: async () => rows }) }) as unknown as Parameters<
			typeof getFleetOps
		>[0];

	it('reports the count the seed leader published', async () => {
		const [zone] = await getFleetOps(
			pbWith([{ zone: 'eu-central', workers: 3, queue_depth: 12, worker: 'abc123' }])
		);
		expect(zone.workers).toBe(3);
		// The leader's own id still shows, so an operator can tell which container
		// is doing the seeding when they go reading its logs.
		expect(zone.worker).toBe('abc123');
	});

	it('falls back to 1 for a zone whose worker predates the field', async () => {
		// 0 would render as "no live workers" for a zone that is in fact running
		// fine on a single pre-#311 worker — alarming, and wrong.
		const [zone] = await getFleetOps(pbWith([{ zone: 'us-east', queue_depth: 0 }]));
		expect(zone.workers).toBe(1);
	});

	it('does not confuse an explicit zero with a missing field', async () => {
		// An explicit 0 is a real reading: the leader counted the heartbeat set and
		// found nothing live. That must survive rather than being coerced to 1.
		const [zone] = await getFleetOps(pbWith([{ zone: 'eu-central', workers: 0 }]));
		expect(zone.workers).toBe(0);
	});
});
