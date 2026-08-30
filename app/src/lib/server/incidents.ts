import type PocketBase from 'pocketbase';

export type OpenIncidentInfo = { id: string; started_at: string; cause: string };

/**
 * The current open (unresolved) incident for a monitor, if any.
 * An incident is open while `resolved_at` is empty. Degrades to null rather than
 * failing the page if the filter is rejected.
 */
export async function getOpenIncidentForMonitor(
	pb: PocketBase,
	monitorId: string
): Promise<OpenIncidentInfo | null> {
	try {
		const r = await pb.collection('incidents').getList(1, 1, {
			filter: `monitor="${monitorId}" && resolved_at=""`,
			sort: '-started_at'
		});
		const i = r.items[0];
		if (!i) return null;
		return { id: i.id, started_at: i.started_at, cause: i.cause ?? '' };
	} catch (err) {
		console.warn('getOpenIncidentForMonitor failed:', err);
		return null;
	}
}

/**
 * When a monitor most recently went down — the `started_at` of its latest incident,
 * open OR resolved (unlike getOpenIncidentForMonitor, which is open-only). Null when
 * the monitor has no incidents on record. Degrades to null rather than failing.
 */
export async function getLastDowntime(pb: PocketBase, monitorId: string): Promise<string | null> {
	try {
		const r = await pb.collection('incidents').getList(1, 1, {
			filter: `monitor="${monitorId}"`,
			sort: '-started_at',
			fields: 'started_at'
		});
		return r.items[0]?.started_at ?? null;
	} catch (err) {
		console.warn('getLastDowntime failed:', err);
		return null;
	}
}
