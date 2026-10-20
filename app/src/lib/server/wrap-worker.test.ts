import { test, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// The cron beat POSTed to /internal/liveness with only an authorization header.
// SvelteKit 3 rejects a mutative request without a Content-Type as cross-site,
// so every beat got a 403 before the handler ran and production /api/health
// read "web" unhealthy (#588). Runs the real wrapper over a stub worker.
test('the scheduled liveness beat carries a content-type and the site origin', async () => {
	// Inside the project (node_modules is ignored everywhere): vitest's module
	// runner will not load a file from outside the root.
	const dir = mkdtempSync(join(resolve('node_modules'), '.wrap-worker-'));
	const out = join(dir, '.svelte-kit', 'cloudflare');
	mkdirSync(out, { recursive: true });
	writeFileSync(
		join(out, '_worker.js'),
		'export default { fetch: async (req) => { globalThis.__beat = req; return new Response(null, { status: 204 }); } };\n'
	);
	execFileSync('node', [resolve('scripts/wrap-worker.mjs')], { cwd: dir });

	const worker = (await import(/* @vite-ignore */ pathToFileURL(join(out, '_worker.js')).href))
		.default;
	const pending: Promise<unknown>[] = [];
	await worker.scheduled(
		{},
		{ HEALTH_DEBUG_TOKEN: 'tok', WEB_URL: 'https://nabz.example/' },
		{ waitUntil: (p: Promise<unknown>) => pending.push(p) }
	);
	await Promise.all(pending);

	const req = (globalThis as unknown as { __beat: Request }).__beat;
	expect(req.method).toBe('POST');
	expect(req.url).toBe('https://nabz.example/internal/liveness');
	expect(req.headers.get('authorization')).toBe('Bearer tok');
	expect(req.headers.get('content-type')).toBe('application/json');
	expect(req.headers.get('origin')).toBe('https://nabz.example');
	rmSync(dir, { recursive: true, force: true });
});

// Customers' cron jobs POST check-ins with curl: no Origin, often no
// Content-Type. SvelteKit 3 refused them with a 403 before /ping ran (#588).
test('a check-in POST reaches the app as same-origin; other routes are left alone', async () => {
	const dir = mkdtempSync(join(resolve('node_modules'), '.wrap-worker-'));
	const out = join(dir, '.svelte-kit', 'cloudflare');
	mkdirSync(out, { recursive: true });
	writeFileSync(
		join(out, '_worker.js'),
		'export default { fetch: async (req) => { (globalThis.__seen ||= []).push(req); return new Response(null, { status: 204 }); } };\n'
	);
	execFileSync('node', [resolve('scripts/wrap-worker.mjs')], { cwd: dir });
	const worker = (await import(/* @vite-ignore */ pathToFileURL(join(out, '_worker.js')).href))
		.default;
	const g = globalThis as unknown as { __seen: Request[] };
	g.__seen = [];

	await worker.fetch(new Request('https://nabz.example/ping/tok123', { method: 'POST' }), {}, {});
	await worker.fetch(
		new Request('https://nabz.example/signin', {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: 'a=b'
		}),
		{},
		{}
	);
	await worker.fetch(new Request('https://nabz.example/ping/tok123'), {}, {});

	expect(g.__seen).toHaveLength(3);
	expect(g.__seen[0].headers.get('origin')).toBe('https://nabz.example');
	expect(g.__seen[0].method).toBe('POST');
	// A browser form route keeps whatever origin it came with (none here): SvelteKit decides.
	expect(g.__seen[1].headers.get('origin')).toBeNull();
	expect(g.__seen[2].headers.get('origin')).toBeNull();
	rmSync(dir, { recursive: true, force: true });
});
