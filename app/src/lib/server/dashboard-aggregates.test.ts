import { test, expect, describe } from 'vitest';
import { getFleetUptime24h, scheduledCheckRate } from './dashboard';

/** These tests exercise liveness, not presentation, so the display label is
 *  filled in from the code rather than restated at every call site. */
const zoneStat = (zone: string, healthy: boolean) => ({ zone, label: zone, healthy });

function fakePb(opts: {
	rollups?: { uptime_pct: number; check_count: number }[];
	partialTotal?: number;
	partialUp?: number;
	rollupsThrow?: boolean;
}) {
	const calls: string[] = [];
	type Query = { filter: string };
	const pb = {
		collection: (name: string) => ({
			getFullList: async ({ filter }: Query) => {
				calls.push(`${name}:${filter}`);
				if (opts.rollupsThrow) throw new Error('rollups unavailable');
				return opts.rollups ?? [];
			},
			getList: async (_p: number, _n: number, { filter }: Query) => {
				calls.push(`${name}:${filter}`);
				const up = filter.includes('up=true');
				return { totalItems: up ? (opts.partialUp ?? 0) : (opts.partialTotal ?? 0) };
			}
		})
	};
	// The functions under test take a PocketBase client; this stub implements only
	// the two calls they make, so the cast is narrowed to the seam rather than
	// spread through the assertions.
	return { pb: pb as unknown as Parameters<typeof getFleetUptime24h>[0], calls };
}

describe('getFleetUptime24h', () => {
	test('weights hourly buckets by check_count, not by bucket', async () => {
		// A tiny 50%-uptime bucket must not drag a large 100% one halfway down.
		// (99×100 + 1×50) / 100 = 99.5
		const { pb } = fakePb({
			rollups: [
				{ uptime_pct: 100, check_count: 99 },
				{ uptime_pct: 50, check_count: 1 }
			]
		});
		expect(await getFleetUptime24h(pb)).toBe(99.5);
	});

	test('includes the in-flight hour, which no bucket covers yet', async () => {
		// Rollups close on the hour, so without this the tile would ignore the most
		// recent hour — the one a user is most likely looking at.
		const { pb } = fakePb({
			rollups: [{ uptime_pct: 100, check_count: 100 }],
			partialTotal: 100,
			partialUp: 0
		});
		expect(await getFleetUptime24h(pb)).toBe(50);
	});

	test('reads rollups, and touches checks only for the partial hour', async () => {
		const { pb, calls } = fakePb({
			rollups: [{ uptime_pct: 100, check_count: 10 }],
			partialTotal: 0
		});
		await getFleetUptime24h(pb);
		expect(calls.some((c) => c.startsWith('rollups:'))).toBe(true);
		// One bounded probe; the second (up=true) is skipped when it finds nothing.
		expect(calls.filter((c) => c.startsWith('checks:'))).toHaveLength(1);
		expect(calls.find((c) => c.startsWith('rollups:'))).toContain('period = "hour"');
	});

	test('null when there is nothing at all to average', async () => {
		const { pb } = fakePb({ rollups: [], partialTotal: 0 });
		expect(await getFleetUptime24h(pb)).toBeNull();
	});

	test('a failed rollup read degrades to the partial hour rather than the whole dashboard', async () => {
		const { pb } = fakePb({ rollupsThrow: true, partialTotal: 4, partialUp: 3 });
		expect(await getFleetUptime24h(pb)).toBe(75);
	});

	test('zero-count buckets are ignored rather than counted as 0% uptime', async () => {
		const { pb } = fakePb({
			rollups: [
				{ uptime_pct: 100, check_count: 10 },
				{ uptime_pct: 0, check_count: 0 }
			]
		});
		expect(await getFleetUptime24h(pb)).toBe(100);
	});
});

describe('scheduledCheckRate', () => {
	const live = [zoneStat('eu', true)];
	const twoLive = [
		zoneStat('eu', true),
		zoneStat('us', true)
	];

	test('unassigned monitors scale with the number of zones', () => {
		// 60/60 per zone × 2 zones = 2/min
		const r = scheduledCheckRate({ perMinuteFixed: 0, perMinutePerZone: 1 }, twoLive);
		expect(r.perMinute).toBe(2);
	});

	test('monitors pinned to zones contribute a fixed rate', () => {
		const r = scheduledCheckRate({ perMinuteFixed: 5, perMinutePerZone: 0 }, twoLive);
		expect(r.perMinute).toBe(5);
	});

	test('a single stale zone makes the whole figure untrustworthy', () => {
		// The point of the tile: it must not read healthy while a worker is dead.
		const r = scheduledCheckRate({ perMinuteFixed: 10, perMinutePerZone: 0 }, [
			zoneStat('eu', true),
			zoneStat('us', false)
		]);
		expect(r.fleetLive).toBe(false);
	});

	test('no zones reporting at all is not live', () => {
		// A fresh instance that has never seen a worker must not claim a rate.
		const r = scheduledCheckRate({ perMinuteFixed: 10, perMinutePerZone: 0 }, []);
		expect(r.fleetLive).toBe(false);
	});

	test('all zones healthy is live', () => {
		expect(scheduledCheckRate({ perMinuteFixed: 1, perMinutePerZone: 0 }, live).fleetLive).toBe(
			true
		);
	});
});
