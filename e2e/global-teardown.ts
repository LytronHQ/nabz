import { execFileSync } from 'node:child_process';
import path from 'node:path';

// Tear the stack down after the suite — unless it was externally managed
// (E2E_SKIP_SETUP) or the run asked to keep it (E2E_KEEP_STACK, for debugging).
export default async function globalTeardown() {
	if (process.env.E2E_SKIP_SETUP === '1' || process.env.E2E_KEEP_STACK === '1') {
		console.log('[e2e] leaving the stack running');
		return;
	}
	execFileSync('bash', [path.join(__dirname, 'setup.sh'), 'down'], { stdio: 'inherit' });
}
