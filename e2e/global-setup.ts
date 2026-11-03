import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { seedStack } from './seed';

// Bring the real stack up before the suite. Skip when it's already managed
// externally (E2E_SKIP_SETUP=1) — e.g. a dev iterating with the stack running.
export default async function globalSetup() {
	// Specs that run `docker compose` themselves (sharding.spec.ts) need the
	// PocketBase version the compose file builds (#613); set it for every worker,
	// also when the stack is already up.
	process.env.E2E_PB_VERSION ||= execFileSync(
		'bash',
		[path.join(__dirname, 'setup.sh'), 'pb-version'],
		{ encoding: 'utf8' }
	).trim();
	if (process.env.E2E_SKIP_SETUP === '1') {
		console.log('[e2e] E2E_SKIP_SETUP=1 — using the already-running stack');
	} else {
		console.log('[e2e] bringing up the stack (builds images on first run)…');
		execFileSync('bash', [path.join(__dirname, 'setup.sh'), 'up'], { stdio: 'inherit' });
	}
	// The Web Push keys setup.sh gives the evaluator and web (#602), for the same
	// reason (#708): sharding.spec.ts's `compose up --scale` recreated the
	// evaluator with empty keys, and every later push delivery was skipped.
	// setup.sh exports them only in its own shell; read them from its file.
	const vapid = path.join(__dirname, '.vapid.env');
	if (existsSync(vapid)) {
		const keys = Object.fromEntries(
			readFileSync(vapid, 'utf8')
				.split('\n')
				.map((l) => l.trim().split(/=(.*)/s, 2))
				.filter(([k, v]) => k && v)
		);
		process.env.E2E_VAPID_PUBLIC_KEY ||= keys.VAPID_PUBLIC_KEY;
		process.env.E2E_VAPID_PRIVATE_KEY ||= keys.VAPID_PRIVATE_KEY;
	} else {
		console.warn('[e2e] no e2e/.vapid.env: specs that rescale the stack leave push without keys');
	}

	// Data specs read but do not create (#606), on a fresh stack or a reused one.
	await seedStack();
	console.log('[e2e] seeded: monitors, a dependency, a resolved incident, day rollups');
}
