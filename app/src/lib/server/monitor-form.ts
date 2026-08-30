import type PocketBase from 'pocketbase';
import { env } from '$env/dynamic/private';
import { EVALUATOR_ZONE, WEB_ZONE, parsePbTime } from '$lib/server/health';
import { getZones, fallbackZone } from '$lib/server/zones';

/** Same window /api/health judges a zone by, so the two never disagree. */
const STALE_MS = (Number(env.HEALTH_STALE_SECONDS) || 90) * 1000;

// Zone names and escalation policies offered by the Add/Edit monitor form (#143).
// Both the New and the Edit pages server-load these so the selects are populated
// on first paint (no client fetch flash). An empty zone selection means "all zones";
// no policy means "notify all channels immediately".
export async function loadMonitorFormOptions(pb: PocketBase, userId: string) {
	const [zoneRes, policies, zones] = await Promise.all([
		pb.collection('zone_stats').getList(1, 100, { sort: 'zone' }),
		pb.collection('escalation_policies').getFullList({
			filter: pb.filter('user = {:user}', { user: userId }),
			sort: 'name',
			fields: 'id,name'
		}),
		// Labels only. Which zones are OFFERED still comes from live heartbeats
		// below — a zones row means "this code has a name", not "a worker is
		// running there" (#328).
		getZones(pb)
	]);
	// Zones carry their liveness (#328). The picker used to offer any zone with a
	// zone_stats row, so a zone whose worker died weeks ago looked identical to a
	// live one — you could pin a monitor to it and get no warning at the moment
	// the choice was made, only silence afterwards.
	const now = Date.now();
	const seen = new Set<string>();
	const availableZones = zoneRes.items
		// Reserved liveness rows, not probe regions — see health.ts.
		.filter((z) => z.zone && z.zone !== EVALUATOR_ZONE && z.zone !== WEB_ZONE)
		.filter((z) => (seen.has(z.zone) ? false : (seen.add(z.zone), true)))
		.map((z) => {
			const t = parsePbTime(z.updated as string | undefined);
			const code = z.zone as string;
			const label = zones.get(code) ?? fallbackZone(code);
			return {
				zone: code,
				// The form submits the CODE and displays the name; a rename must never
				// change what gets written to monitors.zones.
				label: label.displayName,
				group: label.groupName,
				sortOrder: label.sortOrder,
				stale: t == null || now - t > STALE_MS
			};
		})
		.sort((a, b) => a.sortOrder - b.sortOrder || a.zone.localeCompare(b.zone));
	return {
		availableZones,
		availablePolicies: policies.map((p) => ({ id: p.id as string, name: p.name as string }))
	};
}
