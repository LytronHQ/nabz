// Globalping API client for the free check tools (#684), run in the visitor's
// browser: https://globalping.io, docs https://globalping.io/docs/api.globalping.io.
//
// The browser calls the API itself (it answers `access-control-allow-origin: *`),
// so each check counts against the visitor's own anonymous quota (250 tests per
// hour per IP, checked 2026-10-31) and nabz makes no outbound connection on a
// visitor's behalf. Globalping refuses private and reserved targets itself.
//
// Adapted from netcheck's public/globalping.js (github.com/margani/netcheck):
//
//   MIT License
//
//   Copyright (c) 2026 Hossein Margani
//
//   Permission is hereby granted, free of charge, to any person obtaining a copy
//   of this software and associated documentation files (the "Software"), to deal
//   in the Software without restriction, including without limitation the rights
//   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
//   copies of the Software, and to permit persons to whom the Software is
//   furnished to do so, subject to the following conditions:
//
//   The above copyright notice and this permission notice shall be included in
//   all copies or substantial portions of the Software.
//
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
//   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
//   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
//   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
//   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
//   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
//   SOFTWARE.

export const API = 'https://api.globalping.io/v1';

export type Probe = {
	city?: string;
	country?: string;
	continent?: string;
	network?: string;
	asn?: number;
};

export type MeasurementResult = { probe: Probe; result: Record<string, unknown> };
export type Measurement = {
	id: string;
	type: string;
	status: string;
	results: MeasurementResult[];
};

export class GlobalpingError extends Error {
	constructor(
		message: string,
		public rateLimited = false
	) {
		super(message);
	}
}

async function apiError(res: Response): Promise<GlobalpingError> {
	if (res.status === 429) {
		return new GlobalpingError(
			'Your network has used its free Globalping checks for this hour. Try again later.',
			true
		);
	}
	let msg = '';
	try {
		// "Parameter validation failed." alone says nothing; the reason is in params.
		const e = ((await res.json()) as { error?: { message?: string; params?: object } })?.error;
		msg = [e?.message, ...Object.values(e?.params ?? {})].filter(Boolean).join(' ');
	} catch {
		// not JSON
	}
	return new GlobalpingError(msg || `The check could not start (HTTP ${res.status}).`);
}

/**
 * Starts a measurement and polls it until it finishes. The API asks clients to
 * poll no faster than every 500 ms; 30 s covers a slow probe.
 */
export async function runMeasurement(
	body: object,
	{
		onUpdate,
		signal,
		fetchImpl = fetch,
		intervalMs = 500,
		maxMs = 30_000
	}: {
		onUpdate?: (m: Measurement) => void;
		signal?: AbortSignal;
		fetchImpl?: typeof fetch;
		intervalMs?: number;
		maxMs?: number;
	} = {}
): Promise<Measurement> {
	const res = await fetchImpl(`${API}/measurements`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
		signal
	});
	if (!res.ok) throw await apiError(res);
	const { id } = (await res.json()) as { id: string };
	const started = Date.now();
	for (;;) {
		await new Promise((r) => setTimeout(r, intervalMs));
		const r = await fetchImpl(`${API}/measurements/${encodeURIComponent(id)}`, { signal });
		const m = (await r.json()) as Measurement;
		onUpdate?.(m);
		if (m.status !== 'in-progress' || Date.now() - started > maxMs) return m;
	}
}

export function probeLabel(p: Probe = {}): string {
	const place = [p.city, p.country].filter(Boolean).join(', ');
	const net = p.network ? `${p.network}${p.asn ? ` (AS${p.asn})` : ''}` : p.asn ? `AS${p.asn}` : '';
	return [place, net].filter(Boolean).join(' · ');
}
