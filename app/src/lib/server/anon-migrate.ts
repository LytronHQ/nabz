import { serviceClient } from '$lib/server/service-pb';

// Migrate-on-signup (#272, epic #265). Move a visitor's anonymous trial monitor(s)
// from `anon_monitors` into the real `monitors` collection under their new
// account, then delete the anon copies. Runs server-side with the web service
// account — the migrated create sets `user`, which the loosened
// monitors.createRule now allows for service_accounts. Best-effort per row so one
// bad row can't fail signup; returns how many were migrated.
export async function migrateAnonMonitors(sessionToken: string, userId: string): Promise<number> {
	if (!sessionToken || !userId) return 0;

	let pb;
	try {
		pb = await serviceClient();
	} catch {
		return 0; // service account not configured — signup still succeeds
	}

	let anon;
	try {
		anon = await pb
			.collection('anon_monitors')
			.getFullList({ filter: pb.filter('session = {:s}', { s: sessionToken }) });
	} catch (err) {
		console.error('anon migrate: failed to list anon monitors', err);
		return 0;
	}

	let migrated = 0;
	for (const m of anon) {
		try {
			await pb.collection('monitors').create({
				name: m.name,
				type: m.type, // 'website'
				target: m.target,
				interval: m.interval,
				enabled: true,
				status: 'pending',
				zones: [], // empty = the real eu/us zones — leaves the free zone behind
				tags: [],
				config: m.config ?? {},
				user: userId
			});
			await pb.collection('anon_monitors').delete(m.id);
			migrated++;
		} catch (err) {
			console.error('anon migrate: failed for row', m.id, err);
		}
	}
	return migrated;
}
