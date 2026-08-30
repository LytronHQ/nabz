// Tests for the e2e fixture target server (#126). Run: `node --test` in e2e/fixture.
// Starts the server on ephemeral ports and drives every route the suite relies on.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

// Use non-default ports so the test never clashes with a running fixture.
process.env.PORT = '8791';
process.env.TCP_PORT = '9791';
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
