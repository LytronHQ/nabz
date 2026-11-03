import { serviceClient } from '#lib/server/service-pb.js';
import { countMonitors, getAccountPlan } from '#lib/server/plan.js';

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

	if (anon.length === 0) return 0;

	// Plan limits apply here too (#678): signing IN with a trial cookie moves the
	// trial into an existing account, which may already be at its monitor limit.
	// A trial that does not fit is left in anon_monitors, where it expires with
	// its session (#270), rather than pushing the account over its plan.
	let room: number;
	let minInterval: number;
	try {
		const users = await pb
			.collection('users')
			.getList(1, 1, { filter: pb.filter('id = {:id}', { id: userId }), fields: 'id,created' });
		const user = users.items[0] ?? { id: userId, created: null };
		const { plan } = await getAccountPlan(pb, { id: userId, created: user.created as string });
		room = plan.monitors - (await countMonitors(pb, userId));
		minInterval = plan.minIntervalSeconds;
	} catch (err) {
		console.error('anon migrate: failed to read the plan', err);
		return 0;
	}

	let migrated = 0;
	for (const m of anon) {
		if (migrated >= room) {
			console.warn('anon migrate: account is at its monitor limit, trial left to expire', m.id);
			break;
		}
		try {
			await pb.collection('monitors').create({
				name: m.name,
				type: m.type, // 'website'
				target: m.target,
				interval: Math.max(Number(m.interval) || 0, minInterval),
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
