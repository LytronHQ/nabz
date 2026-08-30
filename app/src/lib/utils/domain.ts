// Registrable ("eTLD+1") domain from a monitor target, for the Monitor map's
// by-domain grouping (#222). A dep-free heuristic: it knows the common multi-label
// public suffixes so api.example.co.uk → example.co.uk, not co.uk. This is
// good-enough for a visual grouping; the authoritative Public Suffix List lives on
// the Go side (#195) for the actual domain-expiry lookup.

const MULTI_SUFFIXES = new Set([
	'co.uk',
	'org.uk',
	'gov.uk',
	'ac.uk',
	'me.uk',
	'net.uk',
	'sch.uk',
	'ltd.uk',
	'plc.uk',
	'com.au',
	'net.au',
	'org.au',
	'edu.au',
	'gov.au',
	'id.au',
	'co.nz',
	'net.nz',
	'org.nz',
	'govt.nz',
	'co.jp',
	'ne.jp',
	'or.jp',
	'go.jp',
	'ac.jp',
	'co.kr',
	'or.kr',
	'ne.kr',
	'com.br',
	'net.br',
	'org.br',
	'gov.br',
	'co.za',
	'org.za',
	'net.za',
	'com.sg',
	'com.mx',
	'com.tr',
	'com.cn',
	'net.cn',
	'org.cn',
	'gov.cn',
	'co.in',
	'net.in',
	'org.in',
	'gov.in',
	'firm.in',
	'com.hk',
	'com.tw',
	'com.ar',
	'com.co',
	'com.ua',
	'com.pl',
	'com.ru'
]);

function hostFromTarget(target: string): string | null {
	let t = (target || '').trim();
	if (!t) return null;
	if (t.includes('://')) {
		try {
			return new URL(t).hostname || null;
		} catch {
			return null;
		}
	}
	const slash = t.indexOf('/');
	if (slash >= 0) t = t.slice(0, slash);
	// strip a trailing :port, but not the colons inside a bare [ipv6] literal
	if (!t.startsWith('[')) {
		const colon = t.lastIndexOf(':');
		if (colon > 0 && /^\d+$/.test(t.slice(colon + 1))) t = t.slice(0, colon);
	}
	return t.replace(/^\[|\]$/g, '') || null;
}

function isIp(host: string): boolean {
	if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true; // IPv4
	if (host.includes(':')) return true; // IPv6 literal
	return false;
}

/** eTLD+1 for a target, or null for an IP / localhost / single-label host. */
export function registrableDomain(target: string): string | null {
	let host = hostFromTarget(target);
	if (!host) return null;
	host = host.toLowerCase().replace(/\.$/, '');
	if (isIp(host) || !host.includes('.')) return null;

	const parts = host.split('.');
	const lastTwo = parts.slice(-2).join('.');
	const take = MULTI_SUFFIXES.has(lastTwo) ? 3 : 2;
	if (parts.length <= take) return host;
	return parts.slice(-take).join('.');
}
