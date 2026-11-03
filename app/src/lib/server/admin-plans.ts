import type PocketBase from 'pocketbase';
import { PLANS, resolvePlan, type PlanId, type SubscriptionLike } from '#lib/plans.js';

// Setting an account's plan by hand (#678): until billing lands (#681) this is
// the only way onto Pro besides the launch grant. Runs with the web service
// account, the only identity the subscriptions rules let write.

export type PlanRow = {
	userId: string;
	email: string;
	plan: PlanId;
	source: string;
	note: string;
	updated: string;
};

export type SetPlanResult = { ok: true; message: string } | { ok: false; message: string };

const ACCOUNT_ID = /^[a-z0-9]{15}$/;

/**
 * `account` is an email address or a PocketBase account id. The id is needed for
 * accounts made through GitHub or Google: PocketBase creates those with
 * emailVisibility off, which hides the email from every client but the owner and
 * a superuser, so the service account cannot find them by email at all.
 */
export async function setPlanByEmail(
	pb: PocketBase,
	email: string,
	plan: PlanId,
	note: string
): Promise<SetPlanResult> {
	const address = email.trim().toLowerCase();
	if (!address) return { ok: false, message: 'Enter the account’s email address or id.' };
	if (!(plan in PLANS)) return { ok: false, message: 'Choose Free or Pro.' };

	const byId = ACCOUNT_ID.test(address);
	const users = await pb.collection('users').getList(1, 1, {
		filter: byId
			? pb.filter('id = {:id}', { id: address })
			: pb.filter('email = {:e}', { e: address }),
		fields: 'id,email'
	});
	const user = users.items[0];
	if (!user) {
		return {
			ok: false,
			message: byId
				? `No account has the id ${address}.`
				: `No account the app can see uses ${address}. Accounts made with GitHub or Google hide their email from the app; use the account id instead.`
		};
	}

	const existing = await pb
		.collection('subscriptions')
		.getList(1, 1, { filter: pb.filter('user = {:u}', { u: user.id }) });
	const row = existing.items[0];
	// A Stripe-managed row is billing's to change, not an admin's: overwriting it
	// would put the account out of step with what the customer pays (#681).
	if (row && row.source === 'stripe') {
		return { ok: false, message: `${address} is billed through Stripe; change it there.` };
	}

	const body = {
		user: user.id,
		plan,
		status: 'active',
		source: 'admin',
		note: note.trim().slice(0, 500)
	};
	if (row) await pb.collection('subscriptions').update(row.id, body);
	else await pb.collection('subscriptions').create(body);
	return { ok: true, message: `${address} is now on ${PLANS[plan].name}.` };
}

/** Accounts with a subscriptions row, newest change first. */
export async function listPlanRows(pb: PocketBase): Promise<PlanRow[]> {
	const rows = await pb.collection('subscriptions').getFullList({
		sort: '-updated',
		fields: 'id,user,plan,status,source,note,current_period_end,updated'
	});
	// Emails through a users LIST, not `expand`: expand follows the users view
	// rule, which the service account does not pass (only listRule was widened
	// for it, #246), so the table showed bare account ids.
	const ids = [...new Set(rows.map((r) => r.user as string))];
	const emails = new Map<string, string>();
	for (let i = 0; i < ids.length; i += 50) {
		const chunk = ids.slice(i, i + 50);
		const params = Object.fromEntries(chunk.map((id, n) => [`id${n}`, id]));
		const filter = pb.filter(chunk.map((_, n) => `id = {:id${n}}`).join(' || '), params);
		const users = await pb.collection('users').getFullList({ filter, fields: 'id,email' });
		for (const u of users) emails.set(u.id, u.email as string);
	}
	return rows.map((r) => ({
		userId: r.user as string,
		email: emails.get(r.user as string) ?? '',
		// A subscriptions row resolves to free or pro, never self-hosted.
		plan: resolvePlan(r as unknown as SubscriptionLike, null).plan.id as PlanId,
		source: r.source as string,
		note: (r.note as string) ?? '',
		updated: r.updated as string
	}));
}
