import type PocketBase from 'pocketbase';
import { HOSTED_PLANS } from '$app/env/private';
import {
	SELF_HOSTED,
	monitorLimitMessage,
	resolvePlan,
	type Plan,
	type PlanReason,
	type SubscriptionLike
} from '#lib/plans.js';
import { AlertChannelTypes } from '#lib/models/alert-channel.js';

export type AccountPlan = { plan: Plan; reason: PlanReason };

/**
 * The plan an account is on (#678). `pb` may be the user's own client (the
 * subscriptions listRule lets an owner read their own row) or the service client.
 * A failed read falls back to the account's default plan rather than failing the
 * request: a limit is a business rule, and a PocketBase hiccup must not stop
 * someone saving a monitor on the plan they would have had anyway.
 */
export async function getAccountPlan(
	pb: PocketBase,
	user: { id: string; created?: string | null }
): Promise<AccountPlan> {
	// Plans exist only on nabz's hosted service (#694). Without HOSTED_PLANS this is
	// someone's own install, and its accounts have no limits at all. v0.13.0 shipped
	// without this check, and self-hosted accounts got the Free limits.
	if (!hostedPlans()) return { plan: SELF_HOSTED, reason: 'self-hosted' };
	let sub: SubscriptionLike | null = null;
	try {
		const res = await pb.collection('subscriptions').getList(1, 1, {
			filter: pb.filter('user = {:u}', { u: user.id })
		});
		sub = (res.items[0] as unknown as SubscriptionLike | undefined) ?? null;
	} catch (err) {
		console.error('plan: reading the subscription failed', (err as Error)?.message);
	}
	return resolvePlan(sub, user.created);
}

/** True on nabz's own hosted environments, which set HOSTED_PLANS=true. */
export function hostedPlans(): boolean {
	return String(HOSTED_PLANS ?? '').toLowerCase() === 'true';
}

/** How many monitors the account has. */
export async function countMonitors(pb: PocketBase, userId: string): Promise<number> {
	const res = await pb.collection('monitors').getList(1, 1, {
		filter: pb.filter('user = {:u}', { u: userId }),
		fields: 'id'
	});
	return res.totalItems;
}

/** A refusal the forms show: inline under `field` when one is given, else a toast. */
export function planRefusal(message: string, field?: string): Response {
	if (field) {
		return Response.json(
			{ success: false, message, code: 'plan_limit', errors: [{ field, message }] },
			{ status: 400 }
		);
	}
	// 402 rather than 403: the toast shows a 403 as "You are not allowed to do
	// that", which hides what the plan allows (`friendlyMessage`).
	return Response.json({ success: false, message, code: 'plan_limit' }, { status: 402 });
}

export type PlanUsage = {
	planId: Plan['id'];
	planName: string;
	reason: PlanReason;
	monitors: number | null;
	monitorLimit: number;
	minIntervalSeconds: number;
	channelTypes: string[];
	allChannels: boolean;
	/** False on a self-hosted install, where nothing is limited (#694). */
	limited: boolean;
	/** What the new-monitor page says when the account is full. */
	monitorLimitMessage: string;
};

/**
 * What the /account plan card shows. Never throws: a failed count shows as
 * unknown rather than taking the account page down with it.
 */
export async function getPlanUsage(
	pb: PocketBase,
	user: { id: string; created?: string | null }
): Promise<PlanUsage> {
	const { plan, reason } = await getAccountPlan(pb, user);
	const monitors = await countMonitors(pb, user.id).catch(() => null);
	return {
		planId: plan.id,
		planName: plan.name,
		reason,
		monitors,
		monitorLimit: plan.monitors,
		minIntervalSeconds: plan.minIntervalSeconds,
		channelTypes: [...plan.channelTypes],
		allChannels: plan.channelTypes.length === AlertChannelTypes.length,
		limited: reason !== 'self-hosted',
		monitorLimitMessage: monitorLimitMessage(plan)
	};
}
