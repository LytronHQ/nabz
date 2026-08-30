import { describe, it, expect } from 'vitest';
import { latestPerZone } from './latest-per-zone';

// The real shape from the incident this fixes: each zone failed at 15:28 and
// recovered, so the oldest row in the window says "down, 0 ms" and the newest
// says "up".
const OLDEST_FIRST = [
	{ zone: 'us', checked_at: '2026-08-30 15:28:35.000Z', up: false, response_ms: 0 },
	{ zone: 'eu', checked_at: '2026-08-30 15:28:39.000Z', up: false, response_ms: 0 },
	{ zone: 'us', checked_at: '2026-08-30 16:04:34.000Z', up: true, response_ms: 58 },
	{ zone: 'eu', checked_at: '2026-08-30 16:03:38.000Z', up: true, response_ms: 132 }
];

describe('latestPerZone (#406)', () => {
	it('picks the newest row per zone from an oldest-first list', () => {
		// The reported bug: this list is exactly what fetchRecentChecks returns, and
		// keeping the first occurrence gave the 15:28 failures — a monitor reading
		// Up with every region reading Down.
		const r = latestPerZone(OLDEST_FIRST);
		expect(r.us).toMatchObject({ checked_at: '2026-08-30 16:04:34.000Z', up: true });
		expect(r.eu).toMatchObject({ checked_at: '2026-08-30 16:03:38.000Z', up: true });
	});

	it('gives the same answer whatever order the list arrives in', () => {
		// The actual defence. The old code was correct for one ordering and silently
		// wrong for the other, and nothing here should depend on the caller.
		const forward = latestPerZone(OLDEST_FIRST);
		const reversed = latestPerZone([...OLDEST_FIRST].reverse());
		const shuffled = latestPerZone([OLDEST_FIRST[2], OLDEST_FIRST[0], OLDEST_FIRST[3], OLDEST_FIRST[1]]);
		expect(reversed).toEqual(forward);
		expect(shuffled).toEqual(forward);
	});

	it('surfaces a CURRENT failure that follows an earlier success', () => {
		// The mirror of the bug, and the dangerous direction: a stale success must
		// not hide a zone that is failing right now.
		const r = latestPerZone([
			{ zone: 'eu', checked_at: '2026-08-30 15:00:00.000Z', up: true, response_ms: 90 },
			{ zone: 'eu', checked_at: '2026-08-30 16:00:00.000Z', up: false, response_ms: 0 }
		]);
		expect(r.eu.up).toBe(false);
	});

	it('keeps zones separate', () => {
		const r = latestPerZone(OLDEST_FIRST);
		expect(Object.keys(r).sort()).toEqual(['eu', 'us']);
	});

	it('ignores rows with no zone, and handles an empty list', () => {
		expect(latestPerZone([])).toEqual({});
		expect(latestPerZone([{ zone: '', checked_at: '2026-08-30 16:00:00.000Z' }])).toEqual({});
	});
});
