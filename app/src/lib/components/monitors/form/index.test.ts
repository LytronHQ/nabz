import { test, expect } from 'vitest';
import { render, screen, within } from '@testing-library/svelte';

import Test from './index.test.svelte';
import Form from './index.svelte';
import { MonitorNewItem } from '$lib/models/monitor';

test('renders inline validation messages from the errors prop', () => {
	render(Form, {
		props: {
			data: new MonitorNewItem({ type: 'website' }),
			errors: { name: 'Name is required', target: 'Target is required' }
		}
	});

	expect(screen.getByText('Name is required')).toBeInTheDocument();
	expect(screen.getByText('Target is required')).toBeInTheDocument();
});

test('New monitor', () => {
	render(Test);

	const el = screen.getByTestId('new-data');

	expect(within(el).getByDisplayValue('New Website')).toBeInTheDocument();
	expect(within(el).getByDisplayValue('https://new.example.com')).toBeInTheDocument();
	expect(within(el).getByDisplayValue('60')).toBeInTheDocument();

	// Zone assignment checkboxes render for the available zones.
	expect(within(el).getByLabelText('eu')).toBeInTheDocument();
	expect(within(el).getByLabelText('us')).toBeInTheDocument();
});

test('New monitor only offers implemented types', () => {
	render(Test);

	const el = screen.getByTestId('new-data');

	// The implemented types are selectable...
	for (const name of ['Website', 'Port', 'Ping', 'Heartbeat', 'Dns']) {
		expect(within(el).getByRole('option', { name })).toBeInTheDocument();
	}
	// ...the still-stubbed type is not offered as an option.
	for (const name of ['Duplicati']) {
		expect(within(el).queryByRole('option', { name })).not.toBeInTheDocument();
	}

	// It is surfaced as "coming soon" instead.
	const note = within(el).getByTestId('coming-soon-note');
	expect(note).toHaveTextContent(/coming soon/i);
	expect(note).toHaveTextContent('Duplicati');
});

test('Edit monitor', () => {
	render(Test);

	const el = screen.getByTestId('edit-data');

	expect(within(el).getByDisplayValue('Edit Website')).toBeInTheDocument();
	expect(within(el).getByDisplayValue('https://edit.example.com')).toBeInTheDocument();
	expect(within(el).getByDisplayValue('120')).toBeInTheDocument();
});
