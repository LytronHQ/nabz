import { test, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import type { PushState } from '#lib/utils/push-subscribe.js';

// The browser's push machinery is not in jsdom; the helper is mocked and the
// form's behaviour around it is what is under test (#602).
const prepare = vi.fn<() => Promise<PushState>>();
const subscribe = vi.fn();
vi.mock('#lib/utils/push-subscribe.js', () => ({
	preparePush: () => prepare(),
	subscribe: (s: unknown) => subscribe(s),
	deviceName: () => 'Android phone'
}));

const { default: PushPage } = await import('./push.page.test.svelte');
const { Form } = await import('../');
const { AlertChannelNewItem, AlertChannelItem } = await import('#lib/models/alert-channel.js');

const ready = { kind: 'ready', registration: {}, key: new Uint8Array([1]) } as unknown as PushState;

beforeEach(() => {
	prepare.mockReset();
	subscribe.mockReset();
});

test('turning notifications on fills the subscription and a device name', async () => {
	prepare.mockResolvedValue(ready);
	subscribe.mockResolvedValue({
		endpoint: 'https://fcm.googleapis.com/fcm/send/x',
		p256dh: 'BK',
		auth: 'AU'
	});
	render(PushPage);

	const button = await screen.findByRole('button', {
		name: 'Turn on notifications on this device'
	});
	await fireEvent.click(button);

	expect(await screen.findByText(/This device is ready/)).toBeInTheDocument();
	// Done for this device: no second button inviting it to subscribe again.
	expect(screen.queryByRole('button', { name: /notifications|this device/ })).toBeNull();
	const item = JSON.parse(screen.getByTestId('item').textContent ?? '{}');
	expect(item).toMatchObject({
		type: 'push',
		name: 'Android phone',
		endpoint: 'https://fcm.googleapis.com/fcm/send/x',
		p256dh: 'BK',
		auth: 'AU'
	});
	// Push has no typed fields: no stray inputs from another type.
	expect(screen.queryByText('Webhook URL')).toBeNull();
});

test('a failed subscribe says why and leaves the item untouched', async () => {
	prepare.mockResolvedValue(ready);
	subscribe.mockRejectedValue(new Error('Registration failed - push service not available'));
	render(PushPage);
	await fireEvent.click(await screen.findByRole('button', { name: /Turn on notifications/ }));
	expect(await screen.findByText(/push service not available/)).toBeInTheDocument();
	expect(JSON.parse(screen.getByTestId('item').textContent ?? '{}').endpoint).toBe('');
});

test.each([
	['ios-home-screen', /Add to Home Screen/],
	['blocked', /blocked for nabz/],
	['not-configured', /not set up on this nabz server/],
	['unsupported', /cannot receive push notifications/],
	['no-worker', /background worker is not running/]
] as const)('explains %s instead of offering the button', async (kind, text) => {
	prepare.mockResolvedValue({ kind } as PushState);
	render(Form, { props: { data: new AlertChannelNewItem({ type: 'push' }) } });
	expect(await screen.findByText(text)).toBeInTheDocument();
	expect(screen.queryByRole('button', { name: /Turn on notifications/ })).toBeNull();
});

test('an existing push channel shows its device and offers to move to this one', async () => {
	prepare.mockResolvedValue(ready);
	render(Form, {
		props: {
			data: new AlertChannelItem({
				id: '1',
				type: 'push',
				config: { endpoint: 'https://web.push.apple.com/QX', p256dh: 'BK', auth: 'AU' }
			})
		}
	});
	expect(await screen.findByText('Subscribed: Safari / iPhone (Apple push)')).toBeInTheDocument();
	expect(
		await screen.findByRole('button', { name: 'Use this device instead' })
	).toBeInTheDocument();
});

test('the type list names push and PagerDuty properly', async () => {
	prepare.mockResolvedValue({ kind: 'unsupported' } as PushState);
	render(Form, { props: { data: new AlertChannelNewItem({ type: 'push' }) } });
	expect(screen.getByRole('option', { name: 'Push notification' })).toBeInTheDocument();
	expect(screen.getByRole('option', { name: 'PagerDuty' })).toBeInTheDocument();
});
