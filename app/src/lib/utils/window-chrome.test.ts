import { test, expect, beforeEach } from 'vitest';
import { syncThemeColor, watchThemeColor } from './window-chrome';

function overlay(on: boolean) {
	window.matchMedia = ((q: string) => ({
		matches: on && q === '(display-mode: window-controls-overlay)',
		media: q,
		addEventListener() {},
		removeEventListener() {}
	})) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
	document.head.innerHTML =
		'<meta name="theme-color" media="(prefers-color-scheme: light)" content="#123b40">' +
		'<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0f1719">';
	document.body.innerHTML =
		'<div class="app-titlebar" style="background-color: rgb(255, 255, 255)"></div>';
	document.documentElement.removeAttribute('data-theme');
});

const metas = () =>
	[...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')].map((m) => m.content);

// OS dark, nabz light: the window buttons sat on #161d1f beside a white strip.
test('in the overlay, both theme-color tags take the strip colour', () => {
	overlay(true);
	expect(syncThemeColor()).toBe(true);
	expect(metas()).toEqual(['rgb(255, 255, 255)', 'rgb(255, 255, 255)']);
});

test('outside the overlay, theme-color is left alone', () => {
	overlay(false);
	expect(syncThemeColor()).toBe(false);
	expect(metas()).toEqual(['#123b40', '#0f1719']);
});

test('switching the theme on <html> updates it again', async () => {
	overlay(true);
	const stop = watchThemeColor();
	(document.querySelector('.app-titlebar') as HTMLElement).style.backgroundColor =
		'rgb(23, 31, 33)';
	document.documentElement.setAttribute('data-theme', 'dark');
	await new Promise((r) => setTimeout(r, 0));
	expect(metas()).toEqual(['rgb(23, 31, 33)', 'rgb(23, 31, 33)']);
	stop();
});
