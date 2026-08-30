import { describe, it, expect } from 'vitest';
import { getAvailabilityOverview } from './availability';

type Row = Record<string, unknown>;

/** PocketBase stub: rollups + incidents by collection, and counting getList for
 *  the raw-checks reads the partial hour uses. */
function fakePb(opts: {
	hourRollups?: Row[];
	dayRollups?: Row[];
	incidents?: Row[];
	checksTotal?: number;
	checksUp?: number;
	checksThrow?: boolean;
}) {
	const calls: string[] = [];
	const pb = {
		collection: (name: string) => ({
			getFullList: async ({ filter }: { filter: string }) => {
				calls.push(`${name}:${filter}`);
				if (name === 'incidents') return opts.incidents ?? [];
				if (filter.includes('"hour"')) return opts.hourRollups ?? [];
				if (filter.includes('"day"')) return opts.dayRollups ?? [];
				return [];
			},
			getList: async (_p: number, _n: number, { filter }: { filter: string }) => {
				calls.push(`${name}:${filter}`);
				if (opts.checksThrow) throw new Error('checks unavailable');
				const up = filter.includes('up=true');
				return { totalItems: up ? (opts.checksUp ?? 0) : (opts.checksTotal ?? 0) };
			}
		})
	};
	return { pb: pb as unknown as Parameters<typeof getAvailabilityOverview>[0], calls };
}

const NOW = new Date('2026-08-30T15:17:00.000Z');
const pct = (r: Awaited<ReturnType<typeof getAvailabilityOverview>>) =>
	r.find((x) => x.key === '24h')!.availability;

describe('getAvailabilityOverview 24h (#398)', () => {
	it('reports uptime from the in-flight hour when no rollup has closed yet', async () => {
		// The reported bug: a monitor created minutes ago has no hour bucket, so
		// rollups alone give null and the card renders "—" while the header tile,
		// which counts raw checks, shows a real percentage on the same page.
		const { pb } = fakePb({ hourRollups: [], checksTotal: 4, checksUp: 4 });
		expect(pct(await getAvailabilityOverview(pb, 'm1', NOW))).toBe(100);
	});

	it('a partly-failing first hour is not rounded up to healthy', async () => {
		const { pb } = fakePb({ hourRollups: [], checksTotal: 4, checksUp: 3 });
		expect(pct(await getAvailabilityOverview(pb, 'm1', NOW))).toBe(75);
	});

	it('weights the partial hour with the closed buckets, not alongside them', async () => {
		// 100 checks all up in closed buckets + 100 all down in the current hour
		// must be 50%, not the 0% or 100% you would get by letting one win.
		const { pb } = fakePb({
			hourRollups: [{ bucket_start: '2026-08-30 14:00:00.000Z', uptime_pct: 100, check_count: 100 }],
			checksTotal: 100,
			checksUp: 0
		});
		expect(pct(await getAvailabilityOverview(pb, 'm1', NOW))).toBe(50);
	});

	it('still returns null when there is genuinely nothing — no rollups, no checks', async () => {
		// "No data yet" must stay distinguishable from "0% uptime".
		const { pb } = fakePb({ hourRollups: [], checksTotal: 0 });
		expect(pct(await getAvailabilityOverview(pb, 'm1', NOW))).toBeNull();
	});

	it('degrades to rollups alone when the checks read fails', async () => {
		const { pb } = fakePb({
			hourRollups: [{ bucket_start: '2026-08-30 14:00:00.000Z', uptime_pct: 90, check_count: 10 }],
			checksThrow: true
		});
		expect(pct(await getAvailabilityOverview(pb, 'm1', NOW))).toBe(90);
	});

	it('reads at most one hour of checks, for this monitor only', async () => {
		// The whole point of the rollup tier is not scanning raw checks; the
		// backfill must stay bounded or it reintroduces the cost #324 removed.
		const { pb, calls } = fakePb({ checksTotal: 1, checksUp: 1 });
		await getAvailabilityOverview(pb, 'm1', NOW);
		const checkCalls = calls.filter((c) => c.startsWith('checks:'));
		expect(checkCalls.length).toBeLessThanOrEqual(2);
		for (const c of checkCalls) {
			expect(c).toContain('monitor="m1"');
			expect(c).toContain('2026-08-30 15:00:00'); // the current hour boundary
		}
	});

	it('does not report the bar as "no data" once checks exist', async () => {
		// dataStartMs used to collapse to `now` with no rollups, muting the whole
		// bar even while checks were arriving.
		const { pb } = fakePb({ checksTotal: 3, checksUp: 3 });
		const r = await getAvailabilityOverview(pb, 'm1', NOW);
		expect(r[0].dataStartMs).toBeLessThan(NOW.getTime());
	});
});
