// Subscribing this device for push alerts (#602).
//
// Split in two on purpose. `preparePush` does everything that has to wait (the
// server's key, the service worker registration) before the user taps anything.
// `subscribe` is then called straight from the tap: Safari only shows the
// permission prompt when pushManager.subscribe() runs inside the user gesture,
// and an `await` before it loses the gesture.

export type PushState =
	| { kind: 'ready'; registration: ServiceWorkerRegistration; key: Uint8Array<ArrayBuffer> }
	| { kind: 'unsupported' }
	| { kind: 'ios-home-screen' }
	| { kind: 'blocked' }
	| { kind: 'not-configured' }
	| { kind: 'no-worker' };

export type PushKeys = { endpoint: string; p256dh: string; auth: string };

// An applicationServerKey is the raw key bytes; the server hands it over base64url.
export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
	const b64 = (value + '='.repeat((4 - (value.length % 4)) % 4))
		.replace(/-/g, '+')
		.replace(/_/g, '/');
	const raw = atob(b64);
	const out = new Uint8Array(new ArrayBuffer(raw.length));
	for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
	return out;
}

function isIOS(nav: Navigator): boolean {
	// iPadOS reports itself as a Mac; touch points tell them apart.
	return (
		/iPhone|iPad|iPod/.test(nav.userAgent) ||
		(/Macintosh/.test(nav.userAgent) && nav.maxTouchPoints > 1)
	);
}

function isStandalone(win: Window): boolean {
	return (
		win.matchMedia?.('(display-mode: standalone)').matches ||
		(win.navigator as Navigator & { standalone?: boolean }).standalone === true
	);
}

// serviceWorker.ready never settles when the worker is not running (blocked,
// some private modes, a failed install), which would leave the form "checking"
// forever.
const WORKER_WAIT_MS = 8000;

export async function preparePush(
	win: Window = window,
	workerWaitMs = WORKER_WAIT_MS
): Promise<PushState> {
	const nav = win.navigator;
	const supported = 'serviceWorker' in nav && 'PushManager' in win && 'Notification' in win;
	// iOS only offers Web Push to a web app opened from the Home Screen; in a
	// Safari tab the APIs are simply missing.
	if (isIOS(nav) && !isStandalone(win)) return { kind: 'ios-home-screen' };
	if (!supported) return { kind: 'unsupported' };
	const notification = (win as Window & { Notification: typeof Notification }).Notification;
	if (notification.permission === 'denied') return { kind: 'blocked' };

	const res = await win.fetch('/api/push/key');
	const { publicKey } = res.ok ? ((await res.json()) as { publicKey?: string }) : {};
	if (!publicKey) return { kind: 'not-configured' };

	const registration = await Promise.race([
		nav.serviceWorker.ready,
		new Promise<null>((resolve) => setTimeout(() => resolve(null), workerWaitMs))
	]);
	if (!registration) return { kind: 'no-worker' };
	return { kind: 'ready', registration, key: base64UrlToBytes(publicKey) };
}

function bytesToBase64Url(buf: ArrayBuffer | null): string {
	if (!buf) return '';
	let s = '';
	for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Call directly from the click handler, with no await before it.
export async function subscribe(state: Extract<PushState, { kind: 'ready' }>): Promise<PushKeys> {
	const sub = await state.registration.pushManager.subscribe({
		userVisibleOnly: true,
		applicationServerKey: state.key
	});
	return {
		endpoint: sub.endpoint,
		p256dh: bytesToBase64Url(sub.getKey('p256dh')),
		auth: bytesToBase64Url(sub.getKey('auth'))
	};
}

// A default channel name, so two devices are told apart in escalation policies.
export function deviceName(nav: Navigator = navigator): string {
	const ua = nav.userAgent;
	if (/iPad/.test(ua) || (/Macintosh/.test(ua) && nav.maxTouchPoints > 1)) return 'iPad';
	if (/iPhone|iPod/.test(ua)) return 'iPhone';
	if (/Android/.test(ua)) return 'Android phone';
	if (/Macintosh/.test(ua)) return 'Mac';
	if (/Windows/.test(ua)) return 'Windows PC';
	if (/Linux/.test(ua)) return 'Linux computer';
	return 'This device';
}
