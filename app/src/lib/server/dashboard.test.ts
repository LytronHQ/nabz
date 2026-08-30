import { test, expect } from 'vitest';
import { getZoneStats } from './dashboard';

// A fake PB whose zone_stats.getList returns rows that still CARRY the
// operational fields — so the test proves getZoneStats strips them, not that the
// caller happened not to supply them.
type Row = Record<string, unknown>;

function fakePb(items: Row[], zoneRows: Row[] = []) {
	return {
		collection: (name: string) => ({
			getList: async () => ({ items }),
			// The zones label table (#311). Empty by default, so these tests also
			// cover the fall-back-to-code path.
			getFullList: async () => (name === 'zones' ? zoneRows : [])
		})
	} as unknown as Parameters<typeof getZoneStats>[0];
}

const freshTs = () => new Date().toISOString().replace('T', ' '); // now, PB-style

test('getZoneStats returns only { zone, label, healthy } — no operational fields ship', async () => {
	const rows = await getZoneStats(
		fakePb([
			{
				zone: 'eu',
				updated: freshTs(),
				queue_depth: 42,
				schedule_lag_seconds: 7,
				worker: 'b9dfa6fa698b'
			},
			// The reserved evaluator heartbeat row is not a worker zone → excluded.
			{ zone: 'evaluator', updated: freshTs(), queue_depth: 0, worker: 'evalnode' }
		])
	);

	expect(rows).toEqual([{ zone: 'eu', label: 'eu', healthy: true }]);

	// Nothing operational survives in the serialized payload that reaches the browser.
	const serialized = JSON.stringify(rows);
	for (const leak of [
		'queue_depth',
		'schedule_lag',
		'worker',
		'b9dfa6fa698b',
		'updated',
		'42',
		'7'
	]) {
		expect(serialized, `leaked "${leak}"`).not.toContain(leak);
	}
});

test('a stale zone is marked unhealthy (staleness drives the flag, not shown as a number)', async () => {
	const rows = await getZoneStats(
		fakePb([{ zone: 'us', updated: '2000-01-01 00:00:00.000Z', queue_depth: 1, worker: 'nodeX' }])
	);
	expect(rows).toEqual([{ zone: 'us', label: 'us', healthy: false }]);
});

test('a zone renders its display name, and the code still travels with it (#311)', async () => {
	const rows = await getZoneStats(
		fakePb(
			[{ zone: 'eu-central', updated: freshTs() }],
			[{ code: 'eu-central', display_name: 'EU', sort_order: 10 }]
		)
	);
	// Both, deliberately: the label is what a user reads, the code is what their
	// monitors are pinned to and what appears in a support thread.
	expect(rows).toEqual([{ zone: 'eu-central', label: 'EU', healthy: true }]);
});

test('zones with no label row still render, keyed by code', async () => {
	const rows = await getZoneStats(fakePb([{ zone: 'ap-south', updated: freshTs() }]));
	expect(rows).toEqual([{ zone: 'ap-south', label: 'ap-south', healthy: true }]);
});
