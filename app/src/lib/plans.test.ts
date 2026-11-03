import { describe, expect, it } from 'vitest';
import {
	GRACE_DAYS,
	PLANS,
	PRO_FOR_ACCOUNTS_CREATED_BEFORE,
	channelTypeAllowed,
	formatInterval,
	intervalAllowed,
	intervalMessage,
	listChannels,
	monitorLimitMessage,
	resolvePlan
} from './plans';

const NEW_USER = '2030-01-01 00:00:00.000Z';
const OLD_USER = '2026-01-01 00:00:00.000Z';
const NOW = Date.parse('2030-06-01T00:00:00Z');

describe('resolvePlan', () => {
	it('a new account without a subscription is Free', () => {
		expect(resolvePlan(null, NEW_USER, NOW)).toMatchObject({ plan: PLANS.free, reason: 'default' });
	});

	it('an account from before the launch is Pro', () => {
		expect(resolvePlan(null, OLD_USER, NOW)).toMatchObject({ plan: PLANS.pro, reason: 'launch' });
		expect(Date.parse(OLD_USER.replace(' ', 'T'))).toBeLessThan(
			Date.parse(PRO_FOR_ACCOUNTS_CREATED_BEFORE)
		);
	});

	it('an active Pro subscription is Pro', () => {
		expect(resolvePlan({ plan: 'pro', status: 'active' }, NEW_USER, NOW).plan).toBe(PLANS.pro);
	});

	it('an admin can set an old account to Free', () => {
		expect(resolvePlan({ plan: 'free', status: 'active' }, OLD_USER, NOW).plan).toBe(PLANS.free);
	});

	it('a lapsed Pro keeps Pro through the grace period, then falls back to Free', () => {
		const end = new Date(NOW - (GRACE_DAYS - 1) * 86_400_000).toISOString().replace('T', ' ');
		const gone = new Date(NOW - (GRACE_DAYS + 1) * 86_400_000).toISOString().replace('T', ' ');
		expect(
			resolvePlan({ plan: 'pro', status: 'past_due', current_period_end: end }, NEW_USER, NOW).plan
		).toBe(PLANS.pro);
		expect(
			resolvePlan({ plan: 'pro', status: 'canceled', current_period_end: gone }, NEW_USER, NOW).plan
		).toBe(PLANS.free);
	});

	it('a Pro row that is not active and has no period end is Free', () => {
		expect(resolvePlan({ plan: 'pro', status: 'canceled' }, OLD_USER, NOW).plan).toBe(PLANS.free);
	});
});

describe('limits', () => {
	it('intervals: the plan minimum, or no faster than before', () => {
		expect(intervalAllowed(PLANS.free, 300)).toBe(true);
		expect(intervalAllowed(PLANS.free, 299)).toBe(false);
		expect(intervalAllowed(PLANS.free, 60, 60)).toBe(true);
		expect(intervalAllowed(PLANS.free, 30, 60)).toBe(false);
		expect(intervalAllowed(PLANS.pro, 30)).toBe(true);
	});

	it('channel types: the plan list, or the type the channel already had', () => {
		expect(channelTypeAllowed(PLANS.free, 'email')).toBe(true);
		expect(channelTypeAllowed(PLANS.free, 'slack')).toBe(false);
		expect(channelTypeAllowed(PLANS.free, 'slack', 'slack')).toBe(true);
		expect(channelTypeAllowed(PLANS.pro, 'pagerduty')).toBe(true);
	});
});

describe('wording reads from the plan numbers', () => {
	it('formats intervals in words', () => {
		expect(formatInterval(300)).toBe('5 minutes');
		expect(formatInterval(60)).toBe('1 minute');
		expect(formatInterval(30)).toBe('30 seconds');
		expect(formatInterval(3600)).toBe('1 hour');
	});

	it('lists channels as a sentence', () => {
		expect(listChannels(['email', 'push', 'webhook'])).toBe('email, push and webhook');
		expect(listChannels(['slack'])).toBe('Slack');
	});

	it('messages carry the numbers from PLANS', () => {
		expect(monitorLimitMessage(PLANS.free)).toContain(`${PLANS.free.monitors} monitors`);
		expect(intervalMessage(PLANS.free)).toContain(`${PLANS.free.minIntervalSeconds} seconds`);
	});
});
