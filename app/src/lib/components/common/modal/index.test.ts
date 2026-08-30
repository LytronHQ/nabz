import { test, expect } from 'vitest';
import { render, screen, within } from '@testing-library/svelte';

import Test from './index.test.svelte';
test('modal', () => {
	render(Test);

	const test = screen.getByTestId('open-custom');
	const component = within(test).getByRole('heading');

	expect(component).toBeInTheDocument();
	expect(component).toHaveTextContent('custom title');
});
