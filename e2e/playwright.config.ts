import { defineConfig, devices } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';

// Full-stack e2e (#126). The stack is a real docker-compose fleet brought up by
// global-setup (see setup.sh); tests run against it. The pipeline is async
// (worker seeds/checks, evaluator ticks), so tests poll with generous timeouts
// rather than sleeping.
const WEB = process.env.E2E_WEB || 'http://127.0.0.1:4390';

// Load channel-delivery credentials from the gitignored e2e/.env.local (local
// runs) without a dotenv dependency. In CI these come from repo secrets instead.
// Existing process.env always wins, so CI/secrets aren't overridden.
if (existsSync('.env.local')) {
	for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
		const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
		if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
	}
}

export default defineConfig({
	testDir: './tests',
	// A pipeline test waits on the worker + evaluator loops, so allow real time.
	timeout: 120_000,
	// Headroom for cold SSR on the freshly-built stack (the first authenticated
	// request JIT-compiles the SvelteKit server route).
	expect: { timeout: 20_000 },
	fullyParallel: false,
	workers: 1,
	// One retry absorbs first-hit cold-start flakiness against the just-started
	// stack; a genuine failure still fails twice.
	retries: 1,
	// list → console; json → machine-readable report the CI step turns into a
	// GitHub run summary; github → inline PR annotations on failures (CI only).
	reporter: [
		['list'],
		['json', { outputFile: 'results.json' }],
		...(process.env.CI ? [['github'] as const] : [])
	],
	globalSetup: './global-setup.ts',
	globalTeardown: './global-teardown.ts',
	use: {
		baseURL: WEB,
		trace: 'retain-on-failure'
	},
	// Chromium backs the browser (UI) journeys. The API pipeline spec only uses the
	// `request` fixture, so it runs fine under the same project without a page.
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }]
});
