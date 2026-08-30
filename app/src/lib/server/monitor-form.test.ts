import { test, expect, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: { HEALTH_STALE_SECONDS: '90' } }));

const { loadMonitorFormOptions } = await import('./monitor-form');

const pbTime = (msAgo: number) =>
	new Date(Date.now() - msAgo).toISOString().replace('T', ' ').replace('Z', 'Z');

type Row = Record<string, unknown>;

function fakePb(zoneItems: Row[], zoneRows: Row[] = []) {
	return {
		filter: (e: string) => e,
		collection: (name: string) => ({
			getList: async () => ({ items: zoneItems }),
			getFullList: async () => {
				if (name === 'escalation_policies') return [{ id: 'p1', name: 'Oncall' }];
				if (name === 'zones') return zoneRows;
				return [];
			}
		})
	} as unknown as Parameters<typeof loadMonitorFormOptions>[0];
}

/** The liveness assertions care about which zones are offered and whether they
 *  are marked stale, not about the label fields alongside them. */
const liveness = (zones: { zone: string; stale: boolean }[]) => zones.map((z) => ({ zone: z.zone, stale: z.stale }));

test('a zone with a recent heartbeat is offered as live', async () => {
	const res = await loadMonitorFormOptions(fakePb([{ zone: 'eu', updated: pbTime(10_000) }]), 'u1');
	expect(liveness(res.availableZones)).toEqual([{ zone: 'eu', stale: false }]);
});

test('a zone whose worker stopped is still offered, but marked', async () => {
	// The picker must not hide it — you may be assigning ahead of bringing a
	// worker up — but pinning a monitor to a dead zone has to be a visible choice
	// rather than a silent one (#328).
	const res = await loadMonitorFormOptions(
		fakePb([
			{ zone: 'eu', updated: pbTime(10_000) },
			{ zone: 'us-east', updated: pbTime(6 * 60 * 60 * 1000) }
		]),
		'u1'
	);
	expect(liveness(res.availableZones)).toEqual([
		{ zone: 'eu', stale: false },
		{ zone: 'us-east', stale: true }
	]);
});

test('a zone that has never reported a timestamp counts as stale', async () => {
	const res = await loadMonitorFormOptions(fakePb([{ zone: 'eu', updated: '' }]), 'u1');
	expect(liveness(res.availableZones)).toEqual([{ zone: 'eu', stale: true }]);
});

test('reserved liveness rows are not offered as probe zones, and duplicates collapse', async () => {
	const res = await loadMonitorFormOptions(
		fakePb([
			{ zone: 'eu', updated: pbTime(1000) },
			{ zone: 'evaluator', updated: pbTime(1000) },
			{ zone: 'web', updated: pbTime(1000) },
			{ zone: 'eu', updated: pbTime(1000) },
			{ zone: '', updated: pbTime(1000) }
		]),
		'u1'
	);
	expect(liveness(res.availableZones)).toEqual([{ zone: 'eu', stale: false }]);
});

test('a zone renders its display name while still submitting its code (#311)', async () => {
	const res = await loadMonitorFormOptions(
		fakePb(
			[{ zone: 'eu-central', updated: pbTime(1000) }],
			[{ code: 'eu-central', display_name: 'EU', group_code: 'eu', group_name: 'Europe', sort_order: 10 }]
		),
		'u1'
	);
	// The code is what gets written to monitors.zones — a rename must never
	// change which queue a monitor lands in.
	expect(res.availableZones[0].zone).toBe('eu-central');
	expect(res.availableZones[0].label).toBe('EU');
	expect(res.availableZones[0].group).toBe('Europe');
});

test('a reporting zone with no zones row still renders, labelled by its code', async () => {
	// Hiding it would silently drop a region a user may already have monitors
	// pinned to; an unlabelled zone is only a cosmetic gap.
	const res = await loadMonitorFormOptions(fakePb([{ zone: 'ap-south', updated: pbTime(1000) }]), 'u1');
	expect(res.availableZones).toHaveLength(1);
	expect(res.availableZones[0].label).toBe('ap-south');
});

test('a zones row for a zone with no worker does NOT put it in the picker', async () => {
	// The zones table names zones; it does not assert that one is running. A row
	// without a heartbeat is exactly the dead-zone offer #328 removed.
	const res = await loadMonitorFormOptions(
		fakePb(
			[{ zone: 'eu-central', updated: pbTime(1000) }],
			[
				{ code: 'eu-central', display_name: 'EU', sort_order: 10 },
				{ code: 'us-east', display_name: 'US', sort_order: 20 }
			]
		),
		'u1'
	);
	expect(res.availableZones.map((z) => z.zone)).toEqual(['eu-central']);
});

test('zones are ordered by sort_order, not alphabetically', async () => {
	const res = await loadMonitorFormOptions(
		fakePb(
			[
				{ zone: 'us-east', updated: pbTime(1000) },
				{ zone: 'eu-central', updated: pbTime(1000) }
			],
			[
				{ code: 'us-east', display_name: 'US', sort_order: 10 },
				{ code: 'eu-central', display_name: 'EU', sort_order: 20 }
			]
		),
		'u1'
	);
	expect(res.availableZones.map((z) => z.label)).toEqual(['US', 'EU']);
});

test('a failed zones read degrades to codes rather than failing the form', async () => {
	const pb = {
		filter: (e: string) => e,
		collection: (name: string) => ({
			getList: async () => ({ items: [{ zone: 'eu-central', updated: pbTime(1000) }] }),
			getFullList: async () => {
				if (name === 'zones') throw new Error('zones unavailable');
				return [{ id: 'p1', name: 'Oncall' }];
			}
		})
	} as unknown as Parameters<typeof loadMonitorFormOptions>[0];
	const res = await loadMonitorFormOptions(pb, 'u1');
	expect(res.availableZones[0].label).toBe('eu-central');
});
