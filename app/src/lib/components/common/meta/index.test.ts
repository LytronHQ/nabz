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
