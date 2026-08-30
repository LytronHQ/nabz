import { test, expect } from 'vitest';
import { render, screen, within } from '@testing-library/svelte';

import Test from './index.test.svelte';
test('pagination', () => {
	render(Test);

	const test = screen.getByTestId('custom-data');

	expect(test.innerHTML).contains('Page 1 of 10 of 100 records');
});
