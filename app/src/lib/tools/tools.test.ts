import { describe, expect, it, vi } from 'vitest';
import { ALLOWED_PORTS, TOOLS, parseInput, summarize, toolById, verdict, watchLink } from './tools';
import { runMeasurement, GlobalpingError } from './globalping';

// Result shapes as Globalping returned them on 2026-11-03 (example.com).
const PING_OK = {
	status: 'finished',
	stats: { min: 18.04, max: 18.26, avg: 18.12, total: 3, loss: 0, rcv: 3, drop: 0 }
};
const HTTP_OK = { status: 'finished', statusCode: 200, timings: { total: 182.4 } };
const TLS = (expiresAt: string, authorized = true) => ({
	status: 'finished',
	statusCode: 200,
	tls: {
		authorized,
		expiresAt,
		protocol: 'TLSv1.3',
		subject: { CN: 'example.com' },
		issuer: { O: 'SSL Corporation', CN: 'Cloudflare TLS Issuing ECC CA 3' }
	}
});
const NOW = Date.parse('2026-11-03T12:00:00Z');

describe('parseInput (#684)', () => {
	it('website: adds https, keeps path and query, and uses GET', () => {
		const p = parseInput('website', 'example.com/health?x=1', 'Europe');
		expect(p.ok && p.target).toBe('https://example.com/health?x=1');
		expect(p.ok && p.body).toMatchObject({
			type: 'http',
			target: 'example.com',
			locations: [{ magic: 'Europe' }],
			measurementOptions: {
				protocol: 'HTTPS',
				request: { method: 'GET', path: '/health', query: 'x=1' }
			}
		});
	});

	it('port: only common service ports, so it cannot be used as a port scanner', () => {
		expect(parseInput('port', 'example.com:443', 'world')).toMatchObject({
			ok: true,
			target: 'example.com:443',
			body: { type: 'ping', measurementOptions: { protocol: 'TCP', port: 443 } }
		});
		const odd = parseInput('port', 'example.com:31337', 'world');
		expect(odd.ok).toBe(false);
		expect(!odd.ok && odd.error).toContain('common service ports');
		expect(ALLOWED_PORTS).not.toContain(31337);
		expect(parseInput('port', 'example.com', 'world').ok).toBe(false);
	});

	it('takes a bare host from a pasted URL', () => {
		expect(parseInput('ping', 'https://Example.com/x', 'world')).toMatchObject({
			ok: true,
			target: 'example.com'
		});
		expect(parseInput('ssl', 'https://example.com/a?b', 'world')).toMatchObject({
			ok: true,
			target: 'https://example.com/'
		});
	});

	it('refuses junk, and an unknown location falls back to anywhere', () => {
		expect(parseInput('dns', 'not a host', 'world').ok).toBe(false);
		expect(parseInput('website', 'ftp://example.com', 'world').ok).toBe(false);
		const p = parseInput('dns', 'example.com', 'Mars', 'MX');
		expect(p.ok && p.body).toMatchObject({
			locations: [{ magic: 'world' }],
			measurementOptions: { query: { type: 'MX' } }
		});
	});
});

describe('summarize and verdict', () => {
	it('reads each tool’s result shape', () => {
		expect(summarize('website', HTTP_OK)).toEqual({ ok: true, line: 'HTTP 200 · 182 ms' });
		expect(summarize('website', { status: 'finished', statusCode: 503 }).ok).toBe(false);
		expect(summarize('port', PING_OK)).toEqual({ ok: true, line: 'Open · 18 ms' });
		expect(summarize('ping', { ...PING_OK, stats: { avg: 40, loss: 25 } }).line).toBe(
			'Replies · 40 ms · 25% lost'
		);
		expect(summarize('port', { status: 'failed', stats: { avg: null } }).line).toBe(
			'No connection'
		);
		expect(summarize('dns', { status: 'finished', answers: [{ value: '93.184.215.14' }] })).toEqual(
			{
				ok: true,
				line: '93.184.215.14'
			}
		);
		expect(summarize('website', { status: 'in-progress' }).ok).toBeNull();
	});

	it('ssl: days left, trust, issuer', () => {
		const s = summarize('ssl', TLS('2026-12-25T22:56:35.000Z'), NOW);
		expect(s).toMatchObject({ ok: true, line: 'Trusted · expires in 52 days' });
		expect(s.detail).toContain('SSL Corporation');
		expect(summarize('ssl', TLS('2026-11-01T00:00:00Z'), NOW)).toMatchObject({
			ok: false,
			line: 'Trusted · expired'
		});
		expect(summarize('ssl', TLS('2026-12-25T00:00:00Z', false), NOW).ok).toBe(false);
	});

	it('the verdict waits for every probe, then counts', () => {
		const r = (result: object) => ({ probe: {}, result: result as Record<string, unknown> });
		expect(verdict('website', [r(HTTP_OK), r({ status: 'in-progress' })])).toBeNull();
		expect(verdict('website', [r(HTTP_OK), r(HTTP_OK)])).toBe('Up from all 2 places');
		expect(verdict('website', [r(HTTP_OK), r({ status: 'failed' })])).toBe('Up from 1 of 2 places');
		expect(verdict('port', [r(PING_OK)])).toBe('Open from 1 of 1 place');
	});
});

describe('watchLink', () => {
	const website = toolById('website')!;
	const port = toolById('port')!;
	it('a signed-in visitor gets a prefilled new monitor', () => {
		expect(watchLink(port, 'example.com:443', true).href).toBe(
			'/monitors/new?type=port&target=example.com%3A443'
		);
	});
	it('a signed-out visitor starts the trial for a website, or signs up for anything else', () => {
		expect(watchLink(website, 'https://example.com/', false).href).toBe(
			'/?url=https%3A%2F%2Fexample.com%2F#try'
		);
		expect(watchLink(port, 'example.com:443', false).href).toBe('/signup');
	});
	it('every tool opens a monitor type nabz has', () => {
		for (const t of TOOLS) expect(['website', 'port', 'dns', 'ping']).toContain(t.monitorType);
	});
});

describe('runMeasurement', () => {
	it('posts, then polls until the measurement is no longer in progress', async () => {
		const calls: string[] = [];
		const states = ['in-progress', 'finished'];
		const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
			calls.push(`${init?.method ?? 'GET'} ${url}`);
			if (init?.method === 'POST')
				return new Response(JSON.stringify({ id: 'm1' }), { status: 202 });
			return new Response(JSON.stringify({ id: 'm1', status: states.shift(), results: [] }));
		});
		const m = await runMeasurement(
			{ type: 'ping' },
			{ fetchImpl: fetchImpl as never, intervalMs: 1 }
		);
		expect(m.status).toBe('finished');
		expect(calls).toEqual([
			'POST https://api.globalping.io/v1/measurements',
			'GET https://api.globalping.io/v1/measurements/m1',
			'GET https://api.globalping.io/v1/measurements/m1'
		]);
	});

	it('says plainly when the visitor’s free quota is spent', async () => {
		const fetchImpl = async () => new Response('{}', { status: 429 });
		await expect(runMeasurement({}, { fetchImpl: fetchImpl as never })).rejects.toBeInstanceOf(
			GlobalpingError
		);
		await expect(runMeasurement({}, { fetchImpl: fetchImpl as never })).rejects.toThrow(
			/this hour/
		);
	});
});
