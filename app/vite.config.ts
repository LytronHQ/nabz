import adapterNode from '@sveltejs/adapter-node';
import adapterCloudflare from '@sveltejs/adapter-cloudflare';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

// The web build carries the same version as the Go nodes: the repo-root VERSION
// file, read here so it cannot drift, plus the commit it was built from (#489).
// CI sets GITHUB_SHA; the Docker build gets GIT_COMMIT as a build arg, having no
// .git; a local build asks git. No commit at all leaves it empty, not invented.
const APP_VERSION = readFileSync(new URL('../VERSION', import.meta.url), 'utf8').trim();
function commit(): string {
	const fromEnv = process.env.GIT_COMMIT || process.env.GITHUB_SHA;
	if (fromEnv) return fromEnv;
	try {
		return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
			.toString()
			.trim();
	} catch {
		return '';
	}
}

// The build's name is its version and commit, the same values the UI shows
// (#489), so "which build is this" means one thing for the page, /api/health and
// the service worker's cache (#493). Without a commit, a timestamp keeps every
// build distinct, which is SvelteKit's own default.
function buildName() {
	const sha = commit();
	return `${APP_VERSION}-${sha ? sha.slice(0, 7) : Date.now()}`;
}

// Pick the adapter by ADAPTER env:
//   cloudflare — production: Cloudflare Workers with static assets (wrangler.toml).
//   node       — a standalone Node server (`node build`) for self-hosting on a VM
//                (deploy/web.yml, used on dev VMs).
//   (unset)    — node, so a local/CI build "just works". Was adapter-auto, which
//                on the Cloudflare path only ever printed "could not detect a
//                supported production environment" and produced nothing usable.
function pickAdapter() {
	switch (process.env.ADAPTER) {
		case 'cloudflare':
			return adapterCloudflare();

		case 'node':
			return adapterNode();

		default:
			return adapterNode();
	}
}

export default defineConfig(({ mode }) => ({
	define: {
		...(process.env.VITEST ? {} : { global: 'window' }),
		__APP_VERSION__: JSON.stringify(APP_VERSION),
		__APP_COMMIT__: JSON.stringify(commit())
	},
	plugins: [
		tailwindcss(),
		sveltekit({
			// Consult https://kit.svelte.dev/docs/integrations#preprocessors
			// for more information about preprocessors
			preprocess: vitePreprocess(),
			adapter: pickAdapter(),
			// adapter-node 6 dropped the runtime ORIGIN variable. Without an origin it
			// derives one from the Host header and assumes https, so a self-hosted node
			// served over plain http (the e2e stack, the dev fleet) would reject every
			// sign-in POST as cross-site. ORIGIN is now read at BUILD time (the Docker
			// build gets it as a build arg). Workers derive the origin from the request,
			// so the Cloudflare build never takes it.
			paths: {
				origin: process.env.ADAPTER === 'cloudflare' ? undefined : process.env.ORIGIN || undefined
			},
			version: {
				name: buildName(),
				// An open tab, above all an installed one with no reload button, learns
				// about a new deployment within a minute and offers to reload (#493).
				pollInterval: 60_000
			}
		})
	],
	// Allow importing the repo-root CHANGELOG.md (one level above the app root).
	server: { fs: { allow: ['..'] } },
	// Only override in test, where jsdom needs the browser entry points. Vite 6+
	// resolves conditions per environment, so handing the SSR build an empty array
	// strips `node`/`ssr` and it starts resolving as if it were the browser —
	// which makes SvelteKit's server-only guard fire on hooks.server.ts.
	...(mode === 'test' ? { resolve: { conditions: ['browser'] } } : {}),
	test: {
		include: ['src/**/*.{test,spec}.{js,ts}'],
		globals: true,
		environment: 'jsdom',
		setupFiles: ['./vitest-setup.ts'],
		coverage: {
			provider: 'v8',
			// Measure app source only — not .svelte-kit/ generated code, config, or
			// the tests themselves — so the headline % is honest (#177).
			reporter: ['text-summary', 'json-summary', 'html'],
			// Source files only: vitest 5 counts every matched file, and parsing
			// src/app.html as JavaScript failed the coverage run.
			include: ['src/**/*.{ts,js,svelte}'],
			exclude: ['src/**/*.{test,spec}.*', 'src/**/*.d.ts']
		},
		exclude: ['**/node_modules/**', '**/coverage/**']
	}
}));
