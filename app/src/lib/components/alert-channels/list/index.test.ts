import { test, expect } from 'vitest';
import { render, screen, within } from '@testing-library/svelte';

import Test from './index.test.svelte';

test('renders alert channels with type, name, and destination', () => {
	render(Test);
	const el = screen.getByTestId('list');

	expect(within(el).getByRole('table')).toBeInTheDocument();
	expect(within(el).getByRole('cell', { name: /^webhook$/i })).toBeInTheDocument();
	expect(within(el).getByRole('cell', { name: 'a@b.com' })).toBeInTheDocument();
	// Name column: the set name renders (linked); an unnamed channel shows a dash (#144)
	expect(within(el).getByRole('link', { name: 'Prod Slack' })).toBeInTheDocument();
	expect(within(el).getByRole('cell', { name: '—' })).toBeInTheDocument();
});
