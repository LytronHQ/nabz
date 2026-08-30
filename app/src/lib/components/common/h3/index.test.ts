import { test, expect } from 'vitest';
import { render, screen, within } from '@testing-library/svelte';

import Test from './index.test.svelte';
test('h3', () => {
	render(Test);

	const component = screen.getByRole('heading');
	const child = within(component).getByTestId('child');

	expect(child).toBeInTheDocument();
});
