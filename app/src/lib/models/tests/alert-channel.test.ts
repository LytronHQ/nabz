import { test, expect } from 'vitest';
import {
	AlertChannelTypes,
	AlertChannelItem,
	AlertChannelNewItem,
	AlertChannelItemValidator,
	toChannelConfig
} from '#lib/models/alert-channel.js';

test('the new channel types are present', () => {
	for (const t of ['telegram', 'discord', 'pagerduty']) {
		expect(AlertChannelTypes).toContain(t);
	}
});

test('carries an optional name, trimmed, defaulting to empty (#144)', () => {
	expect(new AlertChannelItem({ id: '1', type: 'webhook', name: '  On-call  ' }).name).toBe(
		'On-call'
	);
	expect(new AlertChannelItem({ id: '2', type: 'webhook' }).name).toBe('');
	expect(new AlertChannelNewItem({ type: 'slack', name: 'Team Slack' }).name).toBe('Team Slack');
	expect(new AlertChannelNewItem({ type: 'slack' }).name).toBe('');
});

test('reads per-type fields from a record’s nested config', () => {
	const item = new AlertChannelItem({
		id: '1',
		type: 'telegram',
		config: { botToken: '123456:ABC-DEF', chatId: '-1001234567890' }
	});
	expect(item.botToken).toBe('123456:ABC-DEF');
	expect(item.chatId).toBe('-1001234567890');
});

test('falls back to a legacy target string when config is empty', () => {
	// Telegram legacy "botToken:chatId" splits on the last colon.
	const tg = new AlertChannelItem({
		id: '1',
		type: 'telegram',
		target: '123456:ABC-DEF:-1001234567890'
	});
	expect(tg.botToken).toBe('123456:ABC-DEF');
	expect(tg.chatId).toBe('-1001234567890');
	// Single-value legacy types map straight across.
	expect(new AlertChannelItem({ id: '2', type: 'webhook', target: 'https://x/y' }).url).toBe(
		'https://x/y'
	);
	expect(new AlertChannelItem({ id: '3', type: 'email', target: 'a@b.com' }).email).toBe('a@b.com');
});

test('toChannelConfig keeps only the fields the type uses', () => {
	const tg = new AlertChannelNewItem({
		type: 'telegram',
		botToken: '123:abc',
		chatId: '-100',
		url: 'ignored'
	});
	expect(toChannelConfig(tg)).toEqual({ botToken: '123:abc', chatId: '-100' });
	const dc = new AlertChannelNewItem({
		type: 'discord',
		url: 'https://discord.com/api/webhooks/1/x'
	});
	expect(toChannelConfig(dc)).toEqual({ url: 'https://discord.com/api/webhooks/1/x' });
	const pd = new AlertChannelNewItem({ type: 'pagerduty', routingKey: 'RK123' });
	expect(toChannelConfig(pd)).toEqual({ routingKey: 'RK123' });
});

const valid = (data: object) =>
	new AlertChannelItemValidator(
		new AlertChannelNewItem(data as ConstructorParameters<typeof AlertChannelNewItem>[0])
	).isValid;

test('telegram requires both bot token and chat id', () => {
	expect(valid({ type: 'telegram', botToken: '123456:ABC-DEF', chatId: '-1001234567890' })).toBe(
		true
	);
	expect(valid({ type: 'telegram', botToken: '123456:ABC-DEF' })).toBe(false); // no chat id
	expect(valid({ type: 'telegram', chatId: '-1001234567890' })).toBe(false); // no token
	expect(valid({ type: 'telegram', botToken: 'not-a-token', chatId: '-100' })).toBe(false); // bad token shape
});

test('discord requires a Discord webhook URL; pagerduty requires its routing key', () => {
	expect(valid({ type: 'discord', url: 'https://discord.com/api/webhooks/1/abc' })).toBe(true);
	expect(valid({ type: 'discord', url: 'https://example.com/x' })).toBe(false);
	expect(valid({ type: 'pagerduty', routingKey: 'RK0123456789' })).toBe(true);
	expect(valid({ type: 'pagerduty' })).toBe(false);
});

// Push (#602): the three subscription values come from pushManager.subscribe(),
// never from typing, so one message covers a missing subscription.
test('push requires a device subscription with an https endpoint', () => {
	const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', p256dh: 'BKey', auth: 'Auth' };
	expect(
		new AlertChannelItemValidator(new AlertChannelNewItem({ type: 'push', ...sub })).isValid
	).toBe(true);

	const none = new AlertChannelItemValidator(new AlertChannelNewItem({ type: 'push' }));
	expect(none.isValid).toBe(false);

	const http = new AlertChannelItemValidator(
		new AlertChannelNewItem({ type: 'push', ...sub, endpoint: 'http://push.example/x' })
	);
	expect(http.isValid).toBe(false);
});

test('push keeps only its subscription in config, and reads it back', () => {
	const sub = { endpoint: 'https://web.push.apple.com/QX', p256dh: 'BKey', auth: 'Auth' };
	expect(toChannelConfig({ type: 'push', ...sub, url: 'https://ignored' })).toEqual(sub);
	const item = new AlertChannelItem({ id: '1', type: 'push', config: sub });
	expect([item.endpoint, item.p256dh, item.auth]).toEqual([sub.endpoint, sub.p256dh, sub.auth]);
});
