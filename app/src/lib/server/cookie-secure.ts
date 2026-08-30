/** Whether the auth cookie should carry the `Secure` attribute (#394).
 *
 *  This used to be `!dev` alone. `dev` is a BUILD-time constant, so a production
 *  build always produced `Secure` — including on the libvirt dev fleet, which
 *  serves plain HTTP. Browsers drop a `Secure` cookie on an http:// origin
 *  silently: no error, nothing in the console, sign-in simply bounces back to
 *  /signin looking exactly like a rejected password.
 *
 *  Build mode and transport are independent, so the flag now comes from the
 *  environment, with the old behaviour as the fallback wherever it is unset.
 *
 *  Deliberately NOT derived from the request protocol: production sits behind
 *  Cloudflare, so the protocol Node sees is meaningless unless `x-forwarded-proto`
 *  is also trusted — which is a separate decision about which proxy headers to
 *  believe, and one that gets this wrong in the unsafe direction.
 *
 *  Defaults to secure. A misconfigured environment then gets a cookie that is too
 *  strict — visible immediately, because nothing works — rather than one that is
 *  too loose, which leaks a session over plaintext and shows no symptom at all.
 */
export function cookieSecure(configured: string | undefined, dev: boolean): boolean {
	if (configured != null && configured.trim() !== '') {
		// Only an explicit, unambiguous "off" disables it. A typo ("FALSE!", "0 ",
		// "no") must not silently drop the Secure flag in production, so anything
		// that is not recognisably false is treated as secure.
		const v = configured.trim().toLowerCase();
		return !(v === 'false' || v === '0' || v === 'no' || v === 'off');
	}
	// Unset: exactly what it did before, so every environment that has not opted
	// in behaves identically.
	return !dev;
}
