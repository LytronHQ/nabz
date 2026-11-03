// Every plan number lives here (#678): the refusal messages, the /account plan
// card, the pricing page (#682) and the terms read them from this file, so they
// cannot drift apart. inkla once advertised one limit and enforced another.
//
// Limits apply only when something is ADDED or made faster. Monitors and channels
// that already exist keep running unchanged, whatever the plan (epic #677).

import type { AlertChannelType } from '#lib/models/alert-channel.js';
import { AlertChannelTypes } from '#lib/models/alert-channel.js';

export type PlanId = 'free' | 'pro';

export interface Plan {
	id: PlanId | 'self-hosted';
	name: string;
	/** How many monitors an account may have. */
	monitors: number;
	/** The fastest check interval, in seconds. */
	minIntervalSeconds: number;
	/** The alert channel types the plan may add. */
	channelTypes: readonly AlertChannelType[];
	/** Public status pages (#679). */
	statusPages: number;
	/** Free pages carry a "powered by nabz" footer, so each one also brings users. */
	statusPageFooter: boolean;
	/** Price in US dollars, tax included (#682). 0 for Free. */
	priceMonthlyUsd: number;
	priceYearlyUsd: number;
	/**
	 * How long check history is kept, in days. NOT applied yet: nothing prunes by
	 * plan today, so no page may promise this number until something does.
	 */
	retentionDays: number;
}

export const PLANS: Record<PlanId, Plan> = {
	free: {
		id: 'free',
		name: 'Free',
		monitors: 10,
		minIntervalSeconds: 300,
		channelTypes: ['email', 'push', 'webhook'],
		statusPages: 1,
		statusPageFooter: true,
		priceMonthlyUsd: 0,
		priceYearlyUsd: 0,
		retentionDays: 30
	},
	pro: {
		id: 'pro',
		name: 'Pro',
		monitors: 100,
		minIntervalSeconds: 30,
		channelTypes: AlertChannelTypes,
		statusPages: 10,
		statusPageFooter: false,
		// Owner's decision, 2026-11-03: $9 a month or $90 a year (two months free).
		priceMonthlyUsd: 9,
		priceYearlyUsd: 90,
		retentionDays: 365
	}
};

/**
 * Every account on a self-hosted install (#694). Plans are for nabz's own hosted
 * service: someone running the open-source code on their own servers gets
 * everything, with no limit and no "Powered by nabz" footer.
 */
export const SELF_HOSTED: Plan = {
	id: 'self-hosted',
	name: 'Self-hosted',
	monitors: Number.POSITIVE_INFINITY,
	minIntervalSeconds: 30,
	channelTypes: AlertChannelTypes,
	statusPages: Number.POSITIVE_INFINITY,
	statusPageFooter: false,
	priceMonthlyUsd: 0,
	priceYearlyUsd: 0,
	retentionDays: Number.POSITIVE_INFINITY
};

/**
 * Accounts created before plans reached production get Pro (owner decision,
 * epic #677). An account created after it starts on Free.
 */
// Set at the v0.13.0 release (approved 2026-11-03), a little after the deploy so
// that every account existing when the limits went live is on Pro.
export const PRO_FOR_ACCOUNTS_CREATED_BEFORE = '2026-11-03T14:00:00Z';

/**
 * Whether Pro can be bought yet. False until billing (#681) is live: the pricing
 * page then says so rather than offering a button that leads nowhere.
 */
export const PRO_ON_SALE = false;

/** Days a lapsed paid subscription keeps its plan before falling back to Free. */
export const GRACE_DAYS = 14;

/** The parts of a `subscriptions` row the plan depends on. */
export interface SubscriptionLike {
	plan: string;
	status: string;
	current_period_end?: string | null;
}

export type PlanReason = 'subscription' | 'launch' | 'default' | 'self-hosted';

/** PocketBase writes dates as "2026-11-03 07:50:00.000Z"; Date wants the T. */
function parseTime(v: string | null | undefined): number | null {
	if (!v) return null;
	const t = Date.parse(v.replace(' ', 'T'));
	return Number.isNaN(t) ? null : t;
}

/**
 * Which plan an account is on. A subscription row wins (an admin can also set an
 * account to Free); without one, accounts from before the launch are Pro and
 * everyone else is Free.
 */
export function resolvePlan(
	subscription: SubscriptionLike | null | undefined,
	userCreated: string | null | undefined,
	now: number = Date.now()
): { plan: Plan; reason: PlanReason } {
	if (subscription) {
		if (subscription.plan === 'pro') {
			if (subscription.status === 'active') return { plan: PLANS.pro, reason: 'subscription' };
			const end = parseTime(subscription.current_period_end);
			if (end !== null && now < end + GRACE_DAYS * 86_400_000) {
				return { plan: PLANS.pro, reason: 'subscription' };
			}
		}
		return { plan: PLANS.free, reason: 'subscription' };
	}
	const created = parseTime(userCreated);
	const cutoff = parseTime(PRO_FOR_ACCOUNTS_CREATED_BEFORE)!;
	if (created !== null && created < cutoff) return { plan: PLANS.pro, reason: 'launch' };
	return { plan: PLANS.free, reason: 'default' };
}

/** 300 → "5 minutes", 30 → "30 seconds", 90 → "90 seconds". */
export function formatInterval(seconds: number): string {
	if (seconds % 3600 === 0) {
		const h = seconds / 3600;
		return h === 1 ? '1 hour' : `${h} hours`;
	}
	if (seconds % 60 === 0) {
		const m = seconds / 60;
		return m === 1 ? '1 minute' : `${m} minutes`;
	}
	return `${seconds} seconds`;
}

const CHANNEL_NAMES: Record<AlertChannelType, string> = {
	email: 'email',
	webhook: 'webhook',
	slack: 'Slack',
	telegram: 'Telegram',
	discord: 'Discord',
	pagerduty: 'PagerDuty',
	push: 'push'
};

export function channelName(type: string): string {
	return CHANNEL_NAMES[type as AlertChannelType] ?? type;
}

/** "email, push and webhook". */
export function listChannels(types: readonly string[]): string {
	const names = types.map(channelName);
	if (names.length <= 1) return names.join('');
	return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * An interval is allowed when it meets the plan's minimum, or when it is no
 * faster than the monitor already ran at: a monitor from before the limits (or
 * from a lapsed Pro plan) can still be renamed or retargeted without being forced
 * slower.
 */
export function intervalAllowed(plan: Plan, interval: number, previous?: number): boolean {
	if (interval >= plan.minIntervalSeconds) return true;
	return previous !== undefined && interval >= previous;
}

/** A channel type is allowed when the plan includes it, or the channel already had it. */
export function channelTypeAllowed(plan: Plan, type: string, previousType?: string): boolean {
	return (plan.channelTypes as readonly string[]).includes(type) || type === previousType;
}

// Refusals are written for a person: what the plan allows, and that what they
// already have keeps working. No "upgrade" link yet: Pro is not on sale until
// billing ships (#681).

export function monitorLimitMessage(plan: Plan): string {
	return (
		`Your ${plan.name} plan includes ${plan.monitors} monitors, and you have reached that. ` +
		'Your monitors keep running. To add another, remove one you no longer need.'
	);
}

export function intervalMessage(plan: Plan): string {
	return (
		`On the ${plan.name} plan a monitor can be checked every ` +
		`${formatInterval(plan.minIntervalSeconds)} at the fastest, so choose ` +
		`${plan.minIntervalSeconds} seconds or more. Monitors you already have keep their interval.`
	);
}

export function channelTypeMessage(plan: Plan, type: string): string {
	return (
		`The ${plan.name} plan sends alerts by ${listChannels(plan.channelTypes)}. ` +
		`${channelName(type)} is not included. Channels you already have keep working.`
	);
}

export function statusPageLimitMessage(plan: Plan): string {
	const n = plan.statusPages;
	return (
		`Your ${plan.name} plan includes ${n} status ${n === 1 ? 'page' : 'pages'}, and you have reached that. ` +
		'Your pages stay online. To add another, remove one you no longer need.'
	);
}
