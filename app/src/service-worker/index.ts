// Installed (standalone) copies of nabz had no service worker, so nothing told
// them a new build existed and they had no reload button to find out (#493).
//
// Deliberately narrow. Only the hashed build output is cached: those files never
// change under one name, so serving them from cache can never be stale. Pages,
// the API and everything else always go to the network, so a signed-in page or a
// monitor's status is never answered from an old copy. The update itself is
// noticed by SvelteKit's version poll (vite.config.ts), not here.
//
// It also shows push alerts (#602): the evaluator encrypts an alert to a device's
// subscription, the browser wakes this worker, and it displays the notification.

import { self as sw } from '$app/service-worker';
import { version } from '$app/env';
import { immutable } from '$app/manifest';

const CACHE = `nabz-${version}`;
// `immutable` paths are relative to the base path (`_app/immutable/…`), and this
// worker is served from the base path, so resolving against its own URL gives the
// absolute pathnames the fetch handler matches (the same thing SvelteKit does for
// the worker's own imports). `resolve()` from $app/paths would too, but its types
// only accept route paths. The prefix filter restates the narrowness above, so a
// manifest that ever lists anything else still never caches a page or the API.
const BUILD = immutable
	.filter((file) => file.path.startsWith('_app/immutable/'))
	.map((file) => new URL(file.path, sw.location.href).pathname);
const ASSETS = new Set(BUILD);

sw.addEventListener('install', (event) => {
	event.waitUntil(
		caches
			.open(CACHE)
			.then((cache) => cache.addAll(BUILD))
			// Take over at once: the cache holds only immutable files, so a page from
			// the previous build loses nothing when this worker replaces the old one.
			.then(() => sw.skipWaiting())
	);
});

sw.addEventListener('activate', (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
			.then(() => sw.clients.claim())
	);
});

sw.addEventListener('fetch', (event) => {
	if (event.request.method !== 'GET') return;
	const url = new URL(event.request.url);
	if (url.origin !== sw.location.origin || !ASSETS.has(url.pathname)) return;
	event.respondWith(
		caches.open(CACHE).then(async (cache) => {
			const hit = await cache.match(url.pathname);
			if (hit) return hit;
			const res = await fetch(event.request);
			if (res.ok) cache.put(url.pathname, res.clone());
			return res;
		})
	);
});

// What the evaluator sends (evaluator/push.go pushMessage).
type PushAlert = { title?: string; body?: string; url?: string; tag?: string };

sw.addEventListener('push', (event) => {
	let alert: PushAlert = {};
	try {
		alert = event.data?.json() ?? {};
	} catch {
		alert = { body: event.data?.text() };
	}
	// Always show something, even for a payload this worker cannot read: Safari
	// revokes the permission of a site whose push displays nothing.
	event.waitUntil(
		sw.registration.showNotification(alert.title || 'nabz', {
			body: alert.body ?? '',
			icon: '/icon-192.png',
			badge: '/icon-192.png',
			// The same incident or monitor replaces its earlier notification rather
			// than stacking: "down" then "recovered" leaves one, current, entry.
			tag: alert.tag || undefined,
			data: { url: alert.url || '/alerts' }
		})
	);
});

sw.addEventListener('notificationclick', (event) => {
	event.notification.close();
	const target = new URL(
		(event.notification.data as { url?: string } | null)?.url || '/alerts',
		sw.location.origin
	);
	// Only ever open nabz itself, whatever the payload says.
	if (target.origin !== sw.location.origin) return;
	event.waitUntil(
		sw.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (windows) => {
			const open = windows.find((w) => new URL(w.url).origin === sw.location.origin);
			if (open) {
				await open.focus();
				return open.navigate(target.href);
			}
			return sw.clients.openWindow(target.href);
		})
	);
});
