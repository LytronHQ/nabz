import { test, expect, vi } from 'vitest';
import { base64UrlToBytes, deviceName, preparePush, subscribe } from './push-subscribe';

const UA = {
	android:
		'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/129.0 Mobile Safari/537.36',
	iphone:
		'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1',
	ipad: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.5 Safari/605.1.15',
	mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/129.0 Safari/537.36'
};

// A minimal Window for preparePush: only what it touches.
function fakeWindow(opts: {
	ua: string;
	touch?: number;
	standalone?: boolean;
	push?: boolean;
	permission?: NotificationPermission;
	key?: string;
}) {
	const registration = { pushManager: { subscribe: vi.fn() } };
	const nav: Record<string, unknown> = { userAgent: opts.ua, maxTouchPoints: opts.touch ?? 0 };
	if (opts.push !== false) nav.serviceWorker = { ready: Promise.resolve(registration) };
	const win: Record<string, unknown> = {
		navigator: nav,
		matchMedia: () => ({ matches: !!opts.standalone }),
		fetch: vi.fn(async () => new Response(JSON.stringify({ publicKey: opts.key ?? '' })))
	};
	if (opts.push !== false) {
		win.PushManager = function () {};
		win.Notification = { permission: opts.permission ?? 'default' };
	}
	return { win: win as unknown as Window, registration };
}

test('base64UrlToBytes decodes an unpadded base64url key', () => {
	expect([...base64UrlToBytes('AQID_-8')]).toEqual([1, 2, 3, 255, 239]);
});

test('deviceName tells common devices apart', () => {
	expect(deviceName({ userAgent: UA.android, maxTouchPoints: 5 } as Navigator)).toBe(
		'Android phone'
	);
	expect(deviceName({ userAgent: UA.iphone, maxTouchPoints: 5 } as Navigator)).toBe('iPhone');
	// iPadOS claims to be a Mac; touch support gives it away.
	expect(deviceName({ userAgent: UA.ipad, maxTouchPoints: 5 } as Navigator)).toBe('iPad');
	expect(deviceName({ userAgent: UA.mac, maxTouchPoints: 0 } as Navigator)).toBe('Mac');
});

test('an iPhone in a Safari tab is sent to the Home Screen first', async () => {
	const { win } = fakeWindow({ ua: UA.iphone, touch: 5, push: false });
	expect((await preparePush(win)).kind).toBe('ios-home-screen');
});

test('an iPad opened from the Home Screen can subscribe', async () => {
	const { win } = fakeWindow({ ua: UA.ipad, touch: 5, standalone: true, key: 'AQID' });
	expect((await preparePush(win)).kind).toBe('ready');
});

test('a browser without the Push API is unsupported', async () => {
	const { win } = fakeWindow({ ua: UA.mac, push: false });
	expect((await preparePush(win)).kind).toBe('unsupported');
});

test('blocked notifications are reported before anything is fetched', async () => {
	const { win } = fakeWindow({ ua: UA.android, permission: 'denied', key: 'AQID' });
	expect((await preparePush(win)).kind).toBe('blocked');
	expect(win.fetch).not.toHaveBeenCalled();
});

test('a server without a key says push is not set up', async () => {
	const { win } = fakeWindow({ ua: UA.android, key: '' });
	expect((await preparePush(win)).kind).toBe('not-configured');
});

test('a service worker that never activates ends the wait instead of hanging', async () => {
	const { win } = fakeWindow({ ua: UA.android, key: 'AQID' });
	(win.navigator as unknown as { serviceWorker: unknown }).serviceWorker = {
		ready: new Promise(() => {})
	};
	expect((await preparePush(win, 20)).kind).toBe('no-worker');
});

test('subscribe returns the endpoint and both keys as base64url', async () => {
	const { win, registration } = fakeWindow({ ua: UA.android, key: 'AQID' });
	const state = await preparePush(win);
	if (state.kind !== 'ready') throw new Error(state.kind);
	registration.pushManager.subscribe.mockResolvedValue({
		endpoint: 'https://fcm.googleapis.com/fcm/send/x',
		getKey: (name: string) => new Uint8Array(name === 'p256dh' ? [4, 251, 255] : [1, 2]).buffer
	});
	expect(await subscribe(state)).toEqual({
		endpoint: 'https://fcm.googleapis.com/fcm/send/x',
		p256dh: 'BPv_',
		auth: 'AQI'
	});
	expect(registration.pushManager.subscribe).toHaveBeenCalledWith({
		userVisibleOnly: true,
		applicationServerKey: new Uint8Array([1, 2, 3])
	});
});
