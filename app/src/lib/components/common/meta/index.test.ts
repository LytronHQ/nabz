import { test, expect } from 'vitest';
import { render } from '@testing-library/svelte';

import EmptyTest from './empty.test.svelte';
test('meta empty', () => {
	render(EmptyTest);

	expect(document.title).toEqual('default title for page | nabz');
});

import WithTitleTest from './with-title.test.svelte';
test('meta not empty', () => {
	render(WithTitleTest);

	expect(document.title).toEqual('custom title | nabz');
});

// Installed, the window already shows the app name: "nabz - Dashboard | nabz".
test('meta drops the suffix inside an installed app window', async () => {
	const original = window.matchMedia;
	window.matchMedia = ((q: string) => ({
		matches: q === '(display-mode: window-controls-overlay)',
		media: q
	})) as unknown as typeof window.matchMedia;
	try {
		render(WithTitleTest);
		await new Promise((r) => setTimeout(r, 0));
		expect(document.title).toEqual('custom title');
	} finally {
		window.matchMedia = original;
	}
});
