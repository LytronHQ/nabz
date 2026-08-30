import { test, expect } from 'vitest';
import { channelTarget, channelDisplayName } from './channel-display';

test('channelTarget returns a secret-safe, type-specific snippet', () => {
	expect(channelTarget({ type: 'email', email: 'a@b.com' })).toBe('a@b.com');
	expect(
		channelTarget({ type: 'webhook', url: 'https://hooks.example.com/services/T/abcdef123' })
	).toBe('hooks.example.com · …def123');
	expect(channelTarget({ type: 'pagerduty', routingKey: 'RK0123456789' })).toBe('RK01…6789');
	expect(channelTarget({ type: 'telegram', chatId: '-100123' })).toBe('chat -100123');
});

test('channelDisplayName prefers the name, else "provider · target"', () => {
	expect(channelDisplayName({ type: 'webhook', name: 'On-call', url: 'https://x/y' })).toBe(
		'On-call'
	);
	// blank/whitespace name falls back
	expect(channelDisplayName({ type: 'email', name: '   ', email: 'a@b.com' })).toBe(
		'email · a@b.com'
	);
	expect(
		channelDisplayName({ type: 'slack', url: 'https://hooks.slack.com/services/T/abcdef' })
	).toBe('slack · hooks.slack.com · …abcdef');
	// no name and no resolvable target -> just the provider
	expect(channelDisplayName({ type: 'webhook' })).toBe('webhook');
});
