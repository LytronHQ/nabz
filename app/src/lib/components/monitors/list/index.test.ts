import { test, expect } from 'vitest';
import { render, screen, within } from '@testing-library/svelte';

import Test from './index.test.svelte';

test('Monitor list shows name, type, status and uptime', () => {
	render(Test);

	const el = screen.getByTestId('list-data');

	const table = within(el).getByRole('table');
	expect(table).toBeInTheDocument();

	expect(within(el).getByRole('cell', { name: /monitor one/i })).toBeInTheDocument();
	expect(within(el).getByRole('cell', { name: /^website$/i })).toBeInTheDocument();
	expect(within(el).getByText('Up')).toBeInTheDocument();
	expect(within(el).getByText('99.9%')).toBeInTheDocument();

	expect(within(el).getByRole('cell', { name: /monitor two/i })).toBeInTheDocument();
	expect(within(el).getByText('Down')).toBeInTheDocument();
});

test('Last downtime column: shows the incident time, or "No incidents recorded" when none', () => {
	render(Test);
	const el = screen.getByTestId('list-data');

	// the column exists
	expect(within(el).getByRole('columnheader', { name: /last downtime/i })).toBeInTheDocument();
	// Monitor Two has no incidents → the placeholder; Monitor One has one → a relative
	// time instead, so the placeholder appears exactly once.
	expect(within(el).getAllByText('No incidents recorded')).toHaveLength(1);
	// Monitor One's incident was ~3 days ago → a relative-time value is shown.
	expect(within(el).getByText(/ago$/i)).toBeInTheDocument();
});
