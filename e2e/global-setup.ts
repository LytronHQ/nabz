import { execFileSync } from 'node:child_process';
import path from 'node:path';

// Bring the real stack up before the suite. Skip when it's already managed
// externally (E2E_SKIP_SETUP=1) — e.g. a dev iterating with the stack running.
export default async function globalSetup() {
	if (process.env.E2E_SKIP_SETUP === '1') {
		console.log('[e2e] E2E_SKIP_SETUP=1 — using the already-running stack');
		return;
	}
	console.log('[e2e] bringing up the stack (builds images on first run)…');
	execFileSync('bash', [path.join(__dirname, 'setup.sh'), 'up'], { stdio: 'inherit' });
}
