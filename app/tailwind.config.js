const plugin = require('tailwindcss/plugin');

// Loaded by app.css through `@config` (Tailwind 4). Only the theme and the forms
// plugin remain here:
//   - flowbite/plugin: removed. flowbite-svelte went in #219/#352 and nothing
//     used the plugin's classes — .btn and friends are defined in app.css.
//   - @tailwindcss/aspect-ratio: removed, v4 has aspect-* natively (and the old
//     `corePlugins: { aspectRatio: false }` that disabled it is gone with it).
//   - darkMode / corePlugins: not supported in v4; dark is a @custom-variant in
//     app.css.
//   - @tailwindcss/forms: moved to an `@plugin` directive in app.css. Declared
//     here under @config, v4 ignores it without a word.
/** @type {import('tailwindcss').Config} */
export default {
	content: ['./src/**/*.{html,js,svelte,ts}'],
	theme: {
		extend: {
			screens: {
				xs: '480px'
			},
			fontFamily: {
				sans: [
					'InterVariable',
					'Inter',
					'system-ui',
					'-apple-system',
					'Segoe UI',
					'Roboto',
					'Helvetica',
					'Arial',
					'sans-serif'
				],
				// Blueprint (#197): no monospace — technical strings are Inter. `font-mono`
				// now resolves to Inter so every legacy `@apply font-mono` renders Inter;
				// headline stat numbers use --font-stat (Space Grotesk) explicitly.
				mono: [
					'InterVariable',
					'Inter',
					'system-ui',
					'-apple-system',
					'Segoe UI',
					'Roboto',
					'Helvetica',
					'Arial',
					'sans-serif'
				],
				stat: ['Space Grotesk', 'InterVariable', 'system-ui', 'sans-serif']
			},
			colors: {
				blue: {
					50: '#F2FCFF',
					100: '#E6F8FC',
					200: '#C0ECFA',
					300: '#99DEF7',
					400: '#51BBF0',
					500: '#0f97eb',
					600: '#0B80D4',
					700: '#0761B0',
					800: '#06498C',
					900: '#033169',
					950: '#011C45'
				},
				green: {
					50: '#f0fcfc',
					100: '#e3fcfc',
					200: '#bcf6f7',
					300: '#92eef0',
					400: '#49e3e6',
					500: '#06d7db',
					600: '#06b8c4',
					700: '#038ea3',
					800: '#036885',
					900: '#014863',
					950: '#012940'
				},
				primary: {
					50: '#f0fcfc',
					100: '#e3fcfc',
					200: '#bcf6f7',
					300: '#92eef0',
					400: '#49e3e6',
					500: '#06d7db',
					600: '#06b8c4',
					700: '#038ea3',
					800: '#036885',
					900: '#014863',
					950: '#012940'
				},
				// --- design tokens (defined as CSS vars in app.css; theme-aware) ---
				ground: 'var(--ground)',
				surface: 'var(--surface)',
				'surface-2': 'var(--surface-2)',
				inset: 'var(--inset)',
				line: 'var(--border)',
				'line-strong': 'var(--border-strong)',
				ink: 'var(--ink)',
				'ink-2': 'var(--ink-2)',
				'ink-3': 'var(--ink-3)',
				'ink-4': 'var(--ink-4)',
				accent: 'var(--accent)',
				'accent-strong': 'var(--accent-strong)',
				'accent-wash': 'var(--accent-wash)',
				up: 'var(--up)',
				'up-wash': 'var(--up-wash)',
				down: 'var(--down)',
				'down-wash': 'var(--down-wash)',
				pending: 'var(--pending)',
				'pending-wash': 'var(--pending-wash)',
				paused: 'var(--paused)',
				'paused-wash': 'var(--paused-wash)'
			}
		}
	},
	plugins: [
		require('@tailwindcss/forms')({
			strategy: 'base'
		}),
		plugin(function ({ addBase }) {
			addBase({
				html: { fontSize: '16px' }
			});
		})
	]
};
