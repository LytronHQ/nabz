import type PocketBase from 'pocketbase';

const HOUR_MS = 60 * 60 * 1000;

// PocketBase-friendly datetime filter string ("YYYY-MM-DD HH:mm:ss.SSSZ").
function pbDate(d: Date): string {
	return d.toISOString().replace('T', ' ');
}

/**
 * 24h uptime percentage for a monitor, computed from the raw `checks` collection.
 * Returns null when there are no checks yet in the window.
 * NOTE: this is O(2 queries) per monitor — fine at Phase 2 scale; replaced by
 * pre-computed rollups in Phase 7.
 */
export async function computeUptime24h(pb: PocketBase, monitorId: string): Promise<number | null> {
	const since = pbDate(new Date(Date.now() - 24 * HOUR_MS));
	const base = `monitor="${monitorId}" && checked_at >= "${since}"`;

	const total = await pb.collection('checks').getList(1, 1, { filter: base });
	if (total.totalItems === 0) return null;

	const up = await pb.collection('checks').getList(1, 1, { filter: `${base} && up=true` });
	return Math.round((up.totalItems / total.totalItems) * 1000) / 10;
}

/** Recent checks for a monitor within the last `hours`, oldest-first (for charting). */
export async function fetchRecentChecks(pb: PocketBase, monitorId: string, hours = 24, max = 500) {
	const since = pbDate(new Date(Date.now() - hours * HOUR_MS));
	// Sort DESCENDING so the `max` cap keeps the MOST RECENT checks — with several
	// zones there are well over `max` per day, and ascending would return the
	// oldest (stale times, and zones that have since come online would be missing).
	// Reverse back to oldest-first, which the page (latest-per-zone, chart) expects.
	const res = await pb.collection('checks').getList(1, max, {
		filter: `monitor="${monitorId}" && checked_at >= "${since}"`,
		sort: '-checked_at'
	});
	return res.items.reverse();
}
