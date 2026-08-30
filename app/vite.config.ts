import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig(({ mode }) => ({
	define: process.env.VITEST ? {} : { global: 'window' },
	plugins: [tailwindcss(), sveltekit()],
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
			include: ['src/**'],
			exclude: ['src/**/*.{test,spec}.*', 'src/**/*.d.ts']
		},
		exclude: ['**/node_modules/**', '**/coverage/**']
	}
}));
