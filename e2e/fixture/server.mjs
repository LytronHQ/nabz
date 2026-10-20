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
//   GET  /canary                 -> 204, or a dropped connection after POST /canary/down
//   POST /canary/down|up         -> the worker's "is it us?" probe fails / works (#598)
//   POST /oauth/github/next      -> sets the identity the next sign-in returns
//   GET  /oauth/github/authorize -> 302 back to redirect_uri with a code (or an error)
//   POST /oauth/github/token     -> exchanges that code for a token
//   GET  /oauth/github/user      -> the identity behind the token (GitHub's /user shape)
//   GET  /oauth/avatar.png       -> a 1x1 PNG, the identity's avatar
//   *    (anything else)         -> 404

import http from 'node:http';
import net from 'node:net';

const PORT = Number(process.env.PORT || 8080);
const TCP_PORT = Number(process.env.TCP_PORT ?? 9090);
const MAX_SLOW_MS = 60_000;

// Last webhook payload received per /hook/:id (the webhook-channel receiver).
const hooks = new Map();
// Last Web Push request per /push/:id (#602): the encrypted body as base64 plus
// the headers a push service reads, so the test can decrypt what nabz sent.
const pushes = new Map();
const PUSH_HEADERS = ['content-encoding', 'ttl', 'urgency', 'topic', 'authorization'];

// A stand-in for GitHub's OAuth endpoints (#609), so the sign-in journey runs
// against PocketBase's real github provider with only its URLs overridden. The
// one piece of state: the identity the next authorize hands out, set by the test
// with POST /oauth/github/next. A code and its token map back to that identity.
const oauthCodes = new Map();
let canaryDown = false;
let oauthNext = null;
const AVATAR_PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/hHmZOgAAAABJRU5ErkJggg==',
	'base64'
);

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

	if (p === '/') return send(res, 200, 'fixture: ok');
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

	// Push service stand-in (#602). POST answers 201 like FCM/APNs and keeps the
	// raw bytes (the body is aes128gcm ciphertext, which readBody's utf8 decode
	// would corrupt); GET returns { headers, body } with body in base64.
	const push = p.match(/^\/push\/([\w-]+)$/);
	if (push) {
		const id = push[1];
		if (req.method === 'POST') {
			const chunks = [];
			for await (const c of req) chunks.push(c);
			const headers = Object.fromEntries(PUSH_HEADERS.map((h) => [h, req.headers[h] ?? '']));
			pushes.set(id, { headers, body: Buffer.concat(chunks).toString('base64') });
			return send(res, 201, '');
		}
		const stored = pushes.get(id);
		if (!stored) return send(res, 404, 'no push yet');
		return send(res, 200, JSON.stringify(stored), {
			'content-type': 'application/json; charset=utf-8'
		});
	}

	// The e2e workers' only canary (WORKER_CANARY_URLS): down, it drops the
	// connection, which is what a worker whose own network is gone sees (#598).
	if (p === '/canary') {
		if (canaryDown) return req.socket.destroy();
		return send(res, 204, '');
	}
	if ((p === '/canary/down' || p === '/canary/up') && req.method === 'POST') {
		canaryDown = p === '/canary/down';
		return send(res, 200, canaryDown ? 'down' : 'up');
	}

	if (p === '/oauth/github/next' && req.method === 'POST') {
		oauthNext = JSON.parse((await readBody(req)) || '{}');
		return send(res, 200, 'ok');
	}
	if (p === '/oauth/github/authorize') {
		const back = new URL(url.searchParams.get('redirect_uri') || '');
		back.searchParams.set('state', url.searchParams.get('state') || '');
		if (!oauthNext || oauthNext.deny) {
			// What GitHub sends when the user clicks Cancel on its consent page.
			back.searchParams.set('error', 'access_denied');
		} else {
			const code = `code-${oauthCodes.size + 1}-${Date.now()}`;
			oauthCodes.set(code, oauthNext);
			back.searchParams.set('code', code);
		}
		oauthNext = null;
		return send(res, 302, '', { location: back.toString() });
	}
	if (p === '/oauth/github/token' && req.method === 'POST') {
		const form = new URLSearchParams(await readBody(req));
		// Like GitHub, refuse a token request without the client secret (in the
		// Basic auth header or the body). Production sign-in once sent none, and a
		// fake that accepted that could not catch it.
		const basic = (req.headers.authorization || '').match(/^Basic (.+)$/i);
		const headerSecret = basic ? Buffer.from(basic[1], 'base64').toString().split(':')[1] : '';
		if (!headerSecret && !form.get('client_secret')) {
			return send(res, 200, JSON.stringify({ error: 'incorrect_client_credentials' }), {
				'content-type': 'application/json'
			});
		}
		const code = form.get('code') || '';
		if (!oauthCodes.has(code))
			return send(res, 400, JSON.stringify({ error: 'bad_verification_code' }));
		return send(
			res,
			200,
			JSON.stringify({
				access_token: `tok-${code}`,
				token_type: 'bearer',
				scope: 'read:user,user:email'
			}),
			{
				'content-type': 'application/json'
			}
		);
	}
	if (p === '/oauth/github/user' || p === '/oauth/github/user/emails') {
		const token = (req.headers.authorization || '').replace(/^(Bearer|token) /i, '');
		const who = oauthCodes.get(token.replace(/^tok-/, ''));
		if (!who) return send(res, 401, 'bad token');
		if (p.endsWith('/emails')) {
			return send(res, 200, JSON.stringify([{ email: who.email, verified: true, primary: true }]), {
				'content-type': 'application/json'
			});
		}
		return send(
			res,
			200,
			JSON.stringify({
				id: who.id,
				login: who.login,
				name: who.name,
				email: who.email,
				avatar_url: who.avatarUrl ?? ''
			}),
			{ 'content-type': 'application/json' }
		);
	}
	if (p === '/oauth/avatar.png') return send(res, 200, AVATAR_PNG, { 'content-type': 'image/png' });

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
			JSON.stringify({
				method: req.method,
				path: url.pathname + url.search,
				headers: req.headers,
				body
			}),
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
		// A port check is free to reset the connection (RST) instead of reading the
		// banner. Without a listener, that ECONNRESET is an unhandled 'error' event
		// and kills the whole fixture — and every later journey fails on a name that
		// no longer resolves.
		socket.on('error', () => {});
		socket.write('fixture-tcp\n');
		socket.end();
	});
}

// Exported for in-process tests; started as a script otherwise.
export function start() {
	return new Promise((resolve) => {
		server.listen(PORT, () => {
			if (tcpServer) {
				tcpServer.listen(TCP_PORT, () =>
					resolve({ server, tcpServer, port: PORT, tcpPort: TCP_PORT })
				);
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
