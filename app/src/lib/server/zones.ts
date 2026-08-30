import type PocketBase from 'pocketbase';

/** A zone's presentation, from the `zones` collection (#311).
 *
 *  `code` is the load-bearing half — the `due:<zone>` queue key, stamped into
 *  every `checks.zone` row, so it is immutable in practice. Everything else here
 *  is presentation and can be edited freely. */
export type Zone = {
	code: string;
	displayName: string;
	groupCode: string;
	groupName: string;
	sortOrder: number;
};

/** Falls back to the code as its own label. A zone reported by a worker but
 *  missing a `zones` row must still render — an unlabelled zone is a cosmetic
 *  gap, whereas hiding it would silently drop a region a user has monitors
 *  pinned to. */
export function fallbackZone(code: string): Zone {
	return { code, displayName: code, groupCode: '', groupName: '', sortOrder: 1000 };
}

/** Reads the zone label table. Returns a Map keyed by code.
 *
 *  Deliberately NOT a source of which zones exist: that still comes from live
 *  `zone_stats` heartbeats (#328), because a row here means "this zone has a
 *  name", not "this zone has a worker". Offering a zone with no worker is the
 *  dead-zone picker #328 removed. */
export async function getZones(pb: PocketBase): Promise<Map<string, Zone>> {
	try {
		const rows = await pb.collection('zones').getFullList({
			filter: 'enabled = true',
			sort: 'sort_order,code',
			fields: 'code,display_name,group_code,group_name,sort_order'
		});
		return new Map(
			rows.map((r: Record<string, unknown>) => {
				const code = r.code as string;
				return [
					code,
					{
						code,
						// An empty display_name is a half-filled row, not an instruction to
						// render nothing.
						displayName: (r.display_name as string) || code,
						groupCode: (r.group_code as string) ?? '',
						groupName: (r.group_name as string) ?? '',
						sortOrder: (r.sort_order as number) ?? 1000
					}
				];
			})
		);
	} catch {
		// Labels are decoration. A zones read that fails must not take down the
		// monitor form or the dashboard with it — callers fall back to codes.
		return new Map();
	}
}

/** Labels a set of zone codes, preserving the table's ordering and falling back
 *  to the bare code for anything unlisted. */
export function labelZones(codes: string[], zones: Map<string, Zone>): Zone[] {
	return codes
		.map((c) => zones.get(c) ?? fallbackZone(c))
		.sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code));
}
