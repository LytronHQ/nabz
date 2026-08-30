import { redirect, type Handle } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import { readAnonToken } from '$lib/server/anon';
import { cookieSecure } from '$lib/server/cookie-secure';
import { createPocketBase } from '$lib/server/pb-client';

/** Where a user with `must_change_password` is sent. */
const FORCED_CHANGE_PATH = '/change-password';

/** Paths that stay reachable while the forced-change gate is up.
 *
 *  The gate has to leave three things alone or it becomes a trap: the change page
 *  itself (or the redirect loops), signing out (a user who cannot change their
 *  password must still be able to leave), and the framework's own asset/data
 *  routes — SvelteKit fetches `__data.json` for a navigation, and redirecting
 *  those breaks the page rather than guarding it. */
export function isPasswordChangeExempt(pathname: string): boolean {
	if (pathname === FORCED_CHANGE_PATH || pathname.startsWith(FORCED_CHANGE_PATH + '/')) return true;
	// Leaving must always be possible, and a user who has forgotten the seeded
	// password needs the reset flow — being unable to change it is exactly the
	// state that would otherwise lock them out permanently. /auth is the OAuth
	// callback; redirecting mid-callback breaks the sign-in it is completing.
	if (pathname === '/logout' || pathname === '/signin' || pathname === '/reset-password')
		return true;
	if (pathname.startsWith('/auth/') || pathname === '/auth') return true;
	// Static and build assets, plus SvelteKit's internal data requests: a
	// navigation fetches `__data.json`, and redirecting that breaks the page
	// rather than guarding it.
	if (pathname.startsWith('/_app/') || pathname.startsWith('/favicon')) return true;
	if (pathname.endsWith('__data.json')) return true;
	// Everything else — including the landing page — is gated. The requirement is
	// that nothing is reachable until the password is changed, and a partial gate
	// invites "which pages are safe?" arguments later.
	return false;
}

export const handle: Handle = async ({ event, resolve }) => {
	// Carries the Cloudflare Access service token and disables auto-cancellation
	// (see $lib/server/pb-client).
	event.locals.pb = createPocketBase();
	event.locals.getPocketBaseFileUrl = (record: any, fileName: any) =>
		event.locals.pb?.files.getURL(record, fileName);

	event.locals.pb.authStore.loadFromCookie(event.request.headers.get('cookie') || '');

	try {
		if (event.locals.pb.authStore.isValid) {
			await event.locals.pb.collection('users').authRefresh();
			const user = structuredClone(event.locals.pb.authStore.record);
			if (user) {
				// NOT the raw PocketBase file URL: PocketBase is behind Access and
				// a browser cannot present a service token (#338). Point at our own
				// proxy instead, which fetches the file server-side. The filename
				// rides along as a cache-buster so a new upload isn't served stale.
				user.avatar = user.avatar ? `/api/avatar?v=${encodeURIComponent(user.avatar)}` : '';
			}

			event.locals.user = user;
		}
	} catch (err) {
		event.locals.pb.authStore.clear();
	}

	// Forced password change (#392). Enforced HERE, in the hook, because route
	// guarding elsewhere is per-page: a check added to each +page.server.ts is one
	// forgotten file away from a hole, and a client-side banner is not enforcement
	// at all — the underlying load functions would still run and return data.
	//
	// Applies to ANY user carrying the flag, not just seeded accounts. Ordinary
	// signups never set it, so they never see this.
	if (event.locals.user?.must_change_password && !isPasswordChangeExempt(event.url.pathname)) {
		throw redirect(303, FORCED_CHANGE_PATH);
	}

	// Anonymous "try it" session (#269) — the signed token, independent of auth.
	event.locals.anonSession = readAnonToken(event.cookies);

	const response = await resolve(event);

	// COOKIE_SECURE, not the build mode (#394). `dev` is a BUILD-time constant, so
	// a production build served over plain HTTP — which is what the libvirt dev
	// fleet is — emitted a Secure cookie the browser then dropped, silently, making
	// every sign-in look like a rejected password. Falls back to `!dev` wherever
	// COOKIE_SECURE is unset, so nothing changes for environments that have not set
	// it.
	const isProd = cookieSecure(env.COOKIE_SECURE, dev);
	// append, not set: replacing would clobber any cookie an endpoint set during
	// resolve (e.g. the anon_session cookie from /api/anon/monitors).
	response.headers.append(
		'set-cookie',
		event.locals.pb.authStore.exportToCookie({ secure: isProd, sameSite: 'Lax' })
	);

	return response;
};
