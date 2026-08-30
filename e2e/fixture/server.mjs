// Deterministic fixture target server for the end-to-end suite (#126).
//
// The e2e tests point real monitors at this server so check-driven features
// (status, latency, redirects, keyword/body assertions, rate-limit handling,
// TCP port up/down) are exercised against a controllable target instead of the
// public internet. Behaviour is encoded in the REQUEST PATH, so every response
// is a pure function of the URL — no shared state, no races, no ordering.
//
// Zero dependencies: Node stdlib only, so it runs with `node server.mjs` and in
// a tiny container with no install step.
//
// Env:
//   PORT      HTTP port  (default 8080)
//   TCP_PORT  raw TCP port kept OPEN, for `port` monitors (default 9090; 0 = off)
//
// Routes (any HTTP method unless noted):
//   GET  /                      -> 200 "fixture: ok"
//   GET  /health                -> 200 (container healthcheck)
//   *    /status/:code          -> :code. 429/503 include Retry-After
//                                  (override ?retryAfter=SECONDS)
//   *    /slow?ms=N             -> 200 after N ms (default 1000, capped 60000)
//   *    /redirect?n=N&to=URL   -> N-hop 302 chain, then 200 (or 302->to on last)
//   *    /body?text=STR&status=C-> status C (default 200) with STR in the body
//                                  (default "keyword") — for body/keyword asserts
//   *    /echo                   -> 200 JSON of {method, path, headers, body}
//                                  — for asserting custom method/headers
//   *    (anything else)         -> 404

import http from 'node:http';
import net from 'node:net';

const PORT = Number(process.env.PORT || 8080);
const TCP_PORT = Number(process.env.TCP_PORT ?? 9090);
const MAX_SLOW_MS = 60_000;

// Last webhook payload received per /hook/:id (the webhook-channel receiver).
const hooks = new Map();

function send(res, status, body, headers = {}) {
	res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers });
	res.end(body ?? '');
}

async function readBody(req) {
	const chunks = [];
	for await (const c of req) chunks.push(c);
	return Buffer.concat(chunks).toString('utf8');
}

// Router keyed on pathname; the URL fully determines the response.
async function handle(req, res, url) {
	const p = url.pathname;

	if (p === '/' ) return send(res, 200, 'fixture: ok');
	if (p === '/health') return send(res, 200, 'ok');

	// Webhook receiver — a test-owned endpoint that records the last payload posted
	// to /hook/:id, so the webhook channel test can read back what nabz actually
	// delivered (the real-delivery assertion, offline & deterministic). POST stores,
	// GET returns the last body (404 until something arrives).
	const hook = p.match(/^\/hook\/([\w-]+)$/);
	if (hook) {
		const id = hook[1];
		if (req.method === 'POST') {
			hooks.set(id, await readBody(req));
			return send(res, 200, 'received');
		}
		const stored = hooks.get(id);
		if (stored === undefined) return send(res, 404, 'no payload yet');
		return send(res, 200, stored, { 'content-type': 'application/json; charset=utf-8' });
	}

	// /status/:code — exact status echo. Rate-limit/unavailable carry Retry-After.
	const status = p.match(/^\/status\/(\d{3})$/);
	if (status) {
		const code = Number(status[1]);
		const headers = {};
		if (code === 429 || code === 503) {
			const ra = url.searchParams.get('retryAfter');
			headers['retry-after'] = String(ra && /^\d+$/.test(ra) ? Number(ra) : 5);
		}
		return send(res, code, `status ${code}`, headers);
	}

	// /slow?ms=N — respond after a delay, for latency-threshold checks/timeouts.
	if (p === '/slow') {
		let ms = Number(url.searchParams.get('ms') || 1000);
		if (!Number.isFinite(ms) || ms < 0) ms = 1000;
		ms = Math.min(ms, MAX_SLOW_MS);
		await new Promise((r) => setTimeout(r, ms));
		return send(res, 200, `slow ${ms}ms`);
	}

	// /redirect?n=N&to=URL — N-hop 302 chain, exercising redirect following.
	if (p === '/redirect') {
		let n = Number(url.searchParams.get('n') || 1);
		if (!Number.isFinite(n) || n < 0) n = 1;
		const to = url.searchParams.get('to');
		if (n <= 0) {
			if (to) return send(res, 302, '', { location: to });
			return send(res, 200, 'redirect: done');
		}
		const next = `/redirect?n=${n - 1}${to ? `&to=${encodeURIComponent(to)}` : ''}`;
		return send(res, 302, '', { location: next });
	}

	// /body?text=STR&status=C — controllable body for keyword/body assertions.
	if (p === '/body') {
		const text = url.searchParams.get('text') ?? 'keyword';
		let code = Number(url.searchParams.get('status') || 200);
		if (!Number.isFinite(code) || code < 100 || code > 599) code = 200;
		return send(res, code, text);
	}

	// /echo — reflect the request so tests can assert method/headers the app sent.
	if (p === '/echo') {
		const body = await readBody(req);
		return send(
			res,
			200,
			JSON.stringify({ method: req.method, path: url.pathname + url.search, headers: req.headers, body }),
			{ 'content-type': 'application/json; charset=utf-8' }
		);
	}

	return send(res, 404, 'fixture: not found');
}

const server = http.createServer((req, res) => {
	const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
	handle(req, res, url).catch((err) => {
		// Never leak a stack to the target's response; keep it a plain 500.
		if (!res.headersSent) send(res, 500, 'fixture: internal error');
		console.error('fixture handler error:', err?.message);
	});
});

// A raw TCP listener that just accepts connections, giving `port` monitors a
// reliably OPEN port. A CLOSED port is any port nothing listens on.
let tcpServer = null;
if (TCP_PORT > 0) {
	tcpServer = net.createServer((socket) => {
		socket.write('fixture-tcp\n');
		socket.end();
	});
}

// Exported for in-process tests; started as a script otherwise.
export function start() {
	return new Promise((resolve) => {
		server.listen(PORT, () => {
			if (tcpServer) {
				tcpServer.listen(TCP_PORT, () => resolve({ server, tcpServer, port: PORT, tcpPort: TCP_PORT }));
			} else {
				resolve({ server, tcpServer: null, port: PORT, tcpPort: 0 });
			}
		});
	});
}

export function stop() {
	return Promise.all([
		new Promise((r) => server.close(r)),
		tcpServer ? new Promise((r) => tcpServer.close(r)) : Promise.resolve()
	]);
}

// Run directly (node server.mjs) but stay importable for tests.
if (import.meta.url === `file://${process.argv[1]}`) {
	start().then(({ port, tcpPort }) => {
		console.log(`fixture server: http on :${port}${tcpPort ? `, tcp on :${tcpPort}` : ''}`);
	});
}
