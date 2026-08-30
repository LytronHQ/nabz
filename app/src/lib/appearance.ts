import { browser } from '$app/environment';
import { writable, get } from 'svelte/store';

export type Theme = 'system' | 'light' | 'dark';

// Blueprint (#197): petrol is the default brand; the rest override --brand. Green/red
// are reserved for status, so they're not accent options.
export const ACCENTS = ['petrol', 'teal', 'blue', 'indigo', 'violet', 'rose'] as const;
export type Accent = (typeof ACCENTS)[number];

/** Swatch colours for the picker (must match the [data-accent] presets in app.css;
    petrol is the theme-aware default, so it has no preset — the swatch matches it). */
export const ACCENT_HEX: Record<Accent, string> = {
	petrol: '#123b40',
	teal: '#0d9488',
	blue: '#2563eb',
	indigo: '#4f46e5',
	violet: '#7c3aed',
	rose: '#e11d48'
};

export const theme = writable<Theme>('system');
export const accent = writable<Accent>('petrol');

function systemPrefersDark(): boolean {
	return browser && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** The effective light/dark for a theme setting ('system' follows the OS). */
export function resolvedDark(t: Theme): boolean {
	return t === 'dark' || (t === 'system' && systemPrefersDark());
}

/** Bridge the resolved theme to Tailwind's `.dark` class, so flowbite's `dark:`
 *  variants (modals, selects, buttons) follow the app theme alongside our tokens. */
function applyDarkClass(t: Theme) {
	if (browser) document.documentElement.classList.toggle('dark', resolvedDark(t));
}

/** Pick up whatever the no-flash head script already applied. */
export function initAppearance() {
	if (!browser) return;
	const t = localStorage.getItem('wm-theme');
	const a = localStorage.getItem('wm-accent');
	const resolvedT: Theme = t === 'light' || t === 'dark' ? t : 'system';
	theme.set(resolvedT);
	accent.set((ACCENTS as readonly string[]).includes(a ?? '') ? (a as Accent) : 'petrol');
	applyDarkClass(resolvedT);
	// When following the OS ('system'), keep the `.dark` class in sync live.
	window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
		if (get(theme) === 'system') applyDarkClass('system');
	});
}

export function setTheme(t: Theme) {
	theme.set(t);
	if (!browser) return;
	localStorage.setItem('wm-theme', t);
	const d = document.documentElement;
	if (t === 'system') d.removeAttribute('data-theme');
	else d.setAttribute('data-theme', t);
	applyDarkClass(t);
}

export function setAccent(a: Accent) {
	accent.set(a);
	if (!browser) return;
	localStorage.setItem('wm-accent', a);
	document.documentElement.setAttribute('data-accent', a);
}
