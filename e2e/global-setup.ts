import { execFileSync } from 'node:child_process';
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
	// Data specs read but do not create (#606), on a fresh stack or a reused one.
	await seedStack();
	console.log('[e2e] seeded: monitors, a dependency, a resolved incident, day rollups');
}
