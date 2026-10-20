// Tests for the e2e fixture target server (#126). Run: `node --test` in e2e/fixture.
// Starts the server on ephemeral ports and drives every route the suite relies on.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

// Free ports from the OS. Fixed ones (8791/9791) hung the whole run when another
// program on the machine already listened there: listen failed, start() never
// resolved, and every test waited forever.
async function freePort() {
	const srv = net.createServer();
	await new Promise((r) => srv.listen(0, '127.0.0.1', r));
	const { port } = srv.address();
	await new Promise((r) => srv.close(r));
	return String(port);
}
process.env.PORT = await freePort();
process.env.TCP_PORT = await freePort();
const { start, stop } = await import('./server.mjs');

const BASE = `http://127.0.0.1:${process.env.PORT}`;

before(() => start());
after(() => stop());

test('/ and /health are 200', async () => {
	assert.equal((await fetch(`${BASE}/`)).status, 200);
	assert.equal((await fetch(`${BASE}/health`)).status, 200);
});

test('/status/:code echoes the status', async () => {
	for (const code of [200, 301, 403, 500]) {
		assert.equal((await fetch(`${BASE}/status/${code}`, { redirect: 'manual' })).status, code);
	}
});

test('429/503 carry a Retry-After header (default + override)', async () => {
	const r1 = await fetch(`${BASE}/status/429`);
	assert.equal(r1.status, 429);
	assert.equal(r1.headers.get('retry-after'), '5');

	const r2 = await fetch(`${BASE}/status/503?retryAfter=30`);
	assert.equal(r2.headers.get('retry-after'), '30');

	// A non-rate-limit status has no Retry-After.
	assert.equal((await fetch(`${BASE}/status/200`)).headers.get('retry-after'), null);
});

test('/slow delays the response by ~ms', async () => {
	const t0 = Date.now();
	const r = await fetch(`${BASE}/slow?ms=300`);
	const elapsed = Date.now() - t0;
	assert.equal(r.status, 200);
	assert.ok(elapsed >= 280, `expected >=280ms, got ${elapsed}`);
});

test('/redirect?n=N produces an N-hop chain ending 200', async () => {
	// Manual redirect: first hop is a 302 to the next hop.
	const first = await fetch(`${BASE}/redirect?n=3`, { redirect: 'manual' });
	assert.equal(first.status, 302);
	assert.equal(first.headers.get('location'), '/redirect?n=2');

	// Auto-followed: the whole chain resolves to the terminal 200 body.
	const followed = await fetch(`${BASE}/redirect?n=3`);
	assert.equal(followed.status, 200);
	assert.equal(await followed.text(), 'redirect: done');
});

test('/body returns the requested text and status', async () => {
	const r = await fetch(`${BASE}/body?text=HELLO-WORLD`);
	assert.equal(r.status, 200);
	assert.equal(await r.text(), 'HELLO-WORLD');

	const r2 = await fetch(`${BASE}/body?text=nope&status=503`);
	assert.equal(r2.status, 503);
	assert.equal(await r2.text(), 'nope');
});

test('/echo reflects method and headers', async () => {
	const r = await fetch(`${BASE}/echo`, { method: 'PUT', headers: { 'x-custom': 'abc' } });
	const j = await r.json();
	assert.equal(j.method, 'PUT');
	assert.equal(j.headers['x-custom'], 'abc');
});

test('/hook/:id records the last POST and replays it (webhook-channel receiver)', async () => {
	// 404 until a payload arrives.
	assert.equal((await fetch(`${BASE}/hook/wh1`)).status, 404);

	// POST stores; GET replays the exact body as JSON.
	const payload = JSON.stringify({ event: 'incident.opened', monitor: 'demo' });
	const post = await fetch(`${BASE}/hook/wh1`, { method: 'POST', body: payload });
	assert.equal(post.status, 200);

	const got = await fetch(`${BASE}/hook/wh1`);
	assert.equal(got.status, 200);
	assert.deepEqual(await got.json(), { event: 'incident.opened', monitor: 'demo' });

	// Isolated per id — a different hook id is still empty.
	assert.equal((await fetch(`${BASE}/hook/other`)).status, 404);
});

test('unknown path is 404', async () => {
	assert.equal((await fetch(`${BASE}/nope`)).status, 404);
});

test('the TCP port is open (accepts a connection)', async () => {
	await new Promise((resolve, reject) => {
		const sock = net.connect(Number(process.env.TCP_PORT), '127.0.0.1');
		sock.on('connect', () => {
			sock.end();
			resolve();
		});
		sock.on('error', reject);
		sock.setTimeout(2000, () => reject(new Error('tcp connect timed out')));
	});
});

// A port check that resets the connection must not take the fixture down. The
// TCP handler had no 'error' listener, so a client's RST became an unhandled
// error event and killed the process — every later journey that needed the
// fixture then failed with "lookup fixture … server misbehaving".
test('a client resetting a TCP connection does not crash the fixture', async () => {
	const port = Number(process.env.TCP_PORT);
	for (let i = 0; i < 20; i++) {
		await new Promise((resolve) => {
			const s = net.connect(port, '127.0.0.1', () => s.resetAndDestroy());
			s.on('error', () => {});
			s.on('close', resolve);
		});
	}
	await new Promise((r) => setTimeout(r, 200));
	const banner = await new Promise((resolve, reject) => {
		const s = net.connect(port, '127.0.0.1');
		let buf = '';
		s.on('data', (d) => (buf += d));
		s.on('end', () => resolve(buf));
		s.on('error', reject);
	});
	assert.equal(banner, 'fixture-tcp\n');
	assert.equal((await fetch(`${BASE}/health`)).status, 200);
});

test('/push/:id keeps the raw body and push headers, answering 201 (#602)', async () => {
	assert.equal((await fetch(`${BASE}/push/p1`)).status, 404);
	// Bytes that are not valid UTF-8 must survive untouched.
	const bytes = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x41]);
	const post = await fetch(`${BASE}/push/p1`, {
		method: 'POST',
		body: bytes,
		headers: { 'content-encoding': 'aes128gcm', ttl: '21600', urgency: 'high', topic: 'incident-x' }
	});
	assert.equal(post.status, 201);
	const got = await (await fetch(`${BASE}/push/p1`)).json();
	assert.deepEqual(Buffer.from(got.body, 'base64'), bytes);
	assert.equal(got.headers['content-encoding'], 'aes128gcm');
	assert.equal(got.headers.ttl, '21600');
	assert.equal(got.headers.urgency, 'high');
	assert.equal(got.headers.topic, 'incident-x');
});

test('/oauth/github: authorize, token and user return the identity set with /next', async () => {
	const who = { id: 42, login: 'octo', name: 'Octo Cat', email: 'octo@e2e.local' };
	assert.equal(
		(await fetch(`${BASE}/oauth/github/next`, { method: 'POST', body: JSON.stringify(who) }))
			.status,
		200
	);
	const auth = await fetch(
		`${BASE}/oauth/github/authorize?state=s1&redirect_uri=${encodeURIComponent('http://web.test/auth/callback')}`,
		{ redirect: 'manual' }
	);
	assert.equal(auth.status, 302);
	const back = new URL(auth.headers.get('location'));
	assert.equal(back.origin + back.pathname, 'http://web.test/auth/callback');
	assert.equal(back.searchParams.get('state'), 's1');
	const code = back.searchParams.get('code');
	assert.ok(code);

	// Without a client secret the token request is refused, as GitHub does.
	const noSecret = await fetch(`${BASE}/oauth/github/token`, {
		method: 'POST',
		body: new URLSearchParams({ code })
	});
	assert.equal((await noSecret.json()).error, 'incorrect_client_credentials');
	const tok = await fetch(`${BASE}/oauth/github/token`, {
		method: 'POST',
		headers: { authorization: 'Basic ' + Buffer.from('id:secret').toString('base64') },
		body: new URLSearchParams({ code })
	});
	const { access_token } = await tok.json();
	const user = await (
		await fetch(`${BASE}/oauth/github/user`, {
			headers: { authorization: `Bearer ${access_token}` }
		})
	).json();
	assert.deepEqual(user, {
		id: 42,
		login: 'octo',
		name: 'Octo Cat',
		email: 'octo@e2e.local',
		avatar_url: ''
	});

	// A second authorize without a new /next is a cancel, like GitHub's Cancel button.
	const again = await fetch(
		`${BASE}/oauth/github/authorize?state=s2&redirect_uri=${encodeURIComponent('http://web.test/cb')}`,
		{
			redirect: 'manual'
		}
	);
	assert.equal(new URL(again.headers.get('location')).searchParams.get('error'), 'access_denied');
	assert.equal(
		(await fetch(`${BASE}/oauth/github/user`, { headers: { authorization: 'Bearer nope' } }))
			.status,
		401
	);
});

test('/canary answers until it is switched down, then drops the connection (#598)', async () => {
	assert.equal((await fetch(`${BASE}/canary`)).status, 204);
	assert.equal((await fetch(`${BASE}/canary/down`, { method: 'POST' })).status, 200);
	await assert.rejects(fetch(`${BASE}/canary`));
	assert.equal((await fetch(`${BASE}/canary/up`, { method: 'POST' })).status, 200);
	assert.equal((await fetch(`${BASE}/canary`)).status, 204);
});
