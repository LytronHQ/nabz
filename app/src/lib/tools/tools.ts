// The free check tools (#684): one-off checks from Globalping's probes, each one
// matching a nabz monitor type, so a visitor who just ran a check is one click
// from watching the same target. Pure: the pages and the tests share it.

import type { MeasurementResult } from '#lib/tools/globalping.js';

export type ToolId = 'website' | 'port' | 'dns' | 'ping' | 'ssl';

export type Tool = {
	id: ToolId;
	/** Short name for links and the index. */
	name: string;
	/** The page's h1, worded the way people search for it. */
	title: string;
	blurb: string;
	inputLabel: string;
	placeholder: string;
	/** The monitor type the "watch this" link opens. */
	monitorType: 'website' | 'port' | 'dns' | 'ping';
};

export const TOOLS: Tool[] = [
	{
		id: 'website',
		name: 'Website check',
		title: 'Is this website up?',
		blurb: 'Open a URL from several countries at once and see who gets an answer.',
		inputLabel: 'URL',
		placeholder: 'https://example.com',
		monitorType: 'website'
	},
	{
		id: 'ssl',
		name: 'SSL certificate check',
		title: 'Check an SSL certificate',
		blurb: 'See who issued a site’s certificate, whether it is trusted, and when it expires.',
		inputLabel: 'Domain',
		placeholder: 'example.com',
		monitorType: 'website'
	},
	{
		id: 'port',
		name: 'Port check',
		title: 'Is this port open?',
		blurb: 'Try a TCP connection to a host and port from several countries.',
		inputLabel: 'Host and port',
		placeholder: 'example.com:443',
		monitorType: 'port'
	},
	{
		id: 'dns',
		name: 'DNS check',
		title: 'Check DNS records from around the world',
		blurb: 'Ask resolvers in several countries for a record and compare the answers.',
		inputLabel: 'Domain',
		placeholder: 'example.com',
		monitorType: 'dns'
	},
	{
		id: 'ping',
		name: 'Ping',
		title: 'Ping a host from around the world',
		blurb: 'Send ICMP pings from several countries and compare the round trip and loss.',
		inputLabel: 'Host',
		placeholder: 'example.com',
		monitorType: 'ping'
	}
];

export const toolById = (id: string): Tool | undefined => TOOLS.find((t) => t.id === id);

/** Where the probes run. Globalping's `magic` accepts these names (netcheck, 2026-11-02). */
export const LOCATIONS = [
	{ value: 'world', label: 'Anywhere' },
	{ value: 'Europe', label: 'Europe' },
	{ value: 'North America', label: 'North America' },
	{ value: 'Asia', label: 'Asia' },
	{ value: 'South America', label: 'South America' },
	{ value: 'Oceania', label: 'Oceania' },
	{ value: 'Africa', label: 'Africa' }
] as const;

export const PROBES = 4;
export const DNS_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT'] as const;

/**
 * The ports the port tool will try. Common service ports only: an open-ended port
 * field would make this a port scanner run from other people's probes, which
 * Globalping's terms forbid and which no monitor needs.
 */
export const ALLOWED_PORTS = [
	21, 22, 25, 53, 80, 110, 143, 443, 465, 587, 993, 995, 1433, 3306, 3389, 5222, 5432, 6379, 8080,
	8443, 27017
] as const;

export type Parsed =
	{ ok: true; target: string; body: Record<string, unknown> } | { ok: false; error: string };

const HOST =
	/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** A bare host from whatever people paste: a URL, host:port or a host. */
function hostOf(raw: string): string | null {
	const text = raw.trim();
	if (!text) return null;
	try {
		const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`);
		const h = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
		return HOST.test(h) || IPV4.test(h) || h.includes(':') ? h : null;
	} catch {
		return null;
	}
}

export function parseInput(
	tool: ToolId,
	raw: string,
	location: string,
	dnsType: string = 'A'
): Parsed {
	const magic = LOCATIONS.some((l) => l.value === location) ? location : 'world';
	const base = { locations: [{ magic }], limit: PROBES };
	switch (tool) {
		case 'website': {
			const text = raw.trim();
			if (!text) return { ok: false, error: 'Enter a URL to check.' };
			// Another scheme would be read as a host: "https://ftp://x" parses as host "ftp".
			if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) && !/^https?:\/\//i.test(text))
				return { ok: false, error: 'Use an http:// or https:// address.' };
			let u: URL;
			try {
				u = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
			} catch {
				return { ok: false, error: 'That does not look like a URL.' };
			}
			if (!/^https?:$/.test(u.protocol) || !hostOf(u.hostname))
				return { ok: false, error: 'Use an http:// or https:// address.' };
			return {
				ok: true,
				target: u.toString(),
				body: {
					...base,
					type: 'http',
					target: u.hostname,
					measurementOptions: {
						protocol: u.protocol === 'https:' ? 'HTTPS' : 'HTTP',
						request: {
							method: 'GET',
							path: u.pathname || '/',
							...(u.search ? { query: u.search.slice(1) } : {})
						},
						...(u.port ? { port: Number(u.port) } : {})
					}
				}
			};
		}
		case 'ssl': {
			const host = hostOf(raw);
			if (!host) return { ok: false, error: 'Enter a domain, such as example.com.' };
			return {
				ok: true,
				target: `https://${host}/`,
				body: {
					...base,
					type: 'http',
					target: host,
					measurementOptions: { protocol: 'HTTPS', request: { method: 'HEAD', path: '/' } }
				}
			};
		}
		case 'port': {
			const m = raw.trim().match(/^(.+):(\d{1,5})$/);
			if (!m) return { ok: false, error: 'Enter a host and a port, such as example.com:443.' };
			const host = hostOf(m[1]);
			const port = Number(m[2]);
			if (!host) return { ok: false, error: 'That host does not look right.' };
			if (!(ALLOWED_PORTS as readonly number[]).includes(port)) {
				return {
					ok: false,
					error: `Port ${port} is not one this tool checks. It tries common service ports only: ${ALLOWED_PORTS.join(', ')}.`
				};
			}
			return {
				ok: true,
				target: `${host}:${port}`,
				body: {
					...base,
					type: 'ping',
					target: host,
					measurementOptions: { protocol: 'TCP', port, packets: 3 }
				}
			};
		}
		case 'dns': {
			const host = hostOf(raw);
			if (!host) return { ok: false, error: 'Enter a domain, such as example.com.' };
			const type = (DNS_TYPES as readonly string[]).includes(dnsType) ? dnsType : 'A';
			return {
				ok: true,
				target: host,
				body: { ...base, type: 'dns', target: host, measurementOptions: { query: { type } } }
			};
		}
		case 'ping': {
			const host = hostOf(raw);
			if (!host) return { ok: false, error: 'Enter a host, such as example.com.' };
			return {
				ok: true,
				target: host,
				body: { ...base, type: 'ping', target: host, measurementOptions: { packets: 4 } }
			};
		}
	}
}

export type Summary = {
	/** true answered, false failed, null still running. */
	ok: boolean | null;
	line: string;
	detail?: string;
};

const ms = (v: unknown) => (typeof v === 'number' ? `${Math.round(v)} ms` : '');
const firstLine = (v: unknown) =>
	String(v ?? '')
		.split('\n')
		.map((l) => l.trim())
		.find(Boolean)
		?.slice(0, 140) ?? '';

/** The days from `now` until an ISO date, rounded down. */
export function daysUntil(iso: string, now = Date.now()): number {
	return Math.floor((Date.parse(iso) - now) / 86_400_000);
}

/** One line per probe. */
export function summarize(tool: ToolId, r: Record<string, unknown>, now = Date.now()): Summary {
	if (r.status === 'in-progress') return { ok: null, line: 'Checking…' };
	const failed = (fallback: string): Summary => ({
		ok: false,
		line: fallback,
		detail: firstLine(r.rawOutput) || undefined
	});
	switch (tool) {
		case 'website': {
			const code = r.statusCode as number | undefined;
			if (typeof code !== 'number') return failed('No answer');
			const timings = r.timings as { total?: number } | undefined;
			return { ok: code >= 200 && code < 400, line: `HTTP ${code} · ${ms(timings?.total)}` };
		}
		case 'ssl': {
			const tls = r.tls as
				| {
						authorized?: boolean;
						expiresAt?: string;
						protocol?: string;
						issuer?: { O?: string; CN?: string };
						subject?: { CN?: string };
						error?: string;
				  }
				| undefined;
			if (!tls?.expiresAt) return failed('No certificate seen');
			const days = daysUntil(tls.expiresAt, now);
			const issuer = tls.issuer?.O || tls.issuer?.CN || 'an unknown issuer';
			const trusted = tls.authorized !== false;
			return {
				ok: trusted && days > 0,
				line: `${trusted ? 'Trusted' : 'Not trusted'} · ${days > 0 ? `expires in ${days} ${days === 1 ? 'day' : 'days'}` : 'expired'}`,
				detail: `${tls.subject?.CN ?? ''} · issued by ${issuer} · ${tls.protocol ?? ''}`.replace(
					/^ · /,
					''
				)
			};
		}
		case 'port':
		case 'ping': {
			const s = r.stats as { avg?: number | null; loss?: number } | undefined;
			if (s?.avg == null) return failed(tool === 'port' ? 'No connection' : 'No reply');
			const loss = typeof s.loss === 'number' && s.loss > 0 ? ` · ${Math.round(s.loss)}% lost` : '';
			return { ok: true, line: `${tool === 'port' ? 'Open' : 'Replies'} · ${ms(s.avg)}${loss}` };
		}
		case 'dns': {
			const answers = ((r.answers as { value?: string }[] | undefined) ?? [])
				.map((a) => a.value)
				.filter(Boolean) as string[];
			if (r.status !== 'finished') return failed('No answer');
			if (answers.length === 0) return { ok: false, line: 'No records' };
			return { ok: true, line: answers.join(', ').slice(0, 300) };
		}
	}
}

/** "Up from 3 of 4 places", or null while any probe is still running. */
export function verdict(
	tool: ToolId,
	results: MeasurementResult[],
	now = Date.now()
): string | null {
	const s = results.map((r) => summarize(tool, r.result, now));
	if (s.length === 0 || s.some((x) => x.ok === null)) return null;
	const good = s.filter((x) => x.ok).length;
	const of = `${good} of ${s.length} ${s.length === 1 ? 'place' : 'places'}`;
	switch (tool) {
		case 'website':
			return good === s.length ? `Up from all ${s.length} places` : `Up from ${of}`;
		case 'port':
			return `Open from ${of}`;
		case 'ping':
			return `Replies from ${of}`;
		case 'dns':
			return `Answered in ${of}`;
		case 'ssl':
			return good === s.length ? 'The certificate is valid' : `Valid as seen from ${of}`;
	}
}

/**
 * The "watch this with nabz" link. A signed-in visitor goes to a prefilled new
 * monitor; a website check can also start the anonymous trial from the landing
 * page; anything else needs an account first.
 */
export function watchLink(
	tool: Tool,
	target: string,
	signedIn: boolean
): { href: string; label: string } {
	const label = `Watch this every few minutes with nabz`;
	if (signedIn) {
		const q = new URLSearchParams({ type: tool.monitorType, target });
		return { href: `/monitors/new?${q}`, label };
	}
	if (tool.monitorType === 'website') {
		return {
			href: `/?${new URLSearchParams({ url: target })}#try`,
			label: 'Watch this free, no sign-up'
		};
	}
	return { href: '/signup', label: 'Sign up free to watch this' };
}
