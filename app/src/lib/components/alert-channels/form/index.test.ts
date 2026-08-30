import { test, expect } from 'vitest';
import { render, screen, within } from '@testing-library/svelte';

import Test from './index.test.svelte';
import { Form } from '../';
import { AlertChannelNewItem } from '$lib/models/alert-channel';

test('renders the alert channel form with the webhook url', () => {
	render(Test);
	const el = screen.getByTestId('form');
	expect(within(el).getByDisplayValue('https://hooks.example.com/x')).toBeInTheDocument();
});

test('shows per-type credential help with a docs link (#176)', () => {
	render(Form, { props: { data: new AlertChannelNewItem({ type: 'slack' }) } });
	expect(screen.getByText(/How do I get a Slack webhook URL/i)).toBeInTheDocument();
	expect(screen.getByRole('link', { name: /Slack incoming webhooks guide/i })).toHaveAttribute(
		'target',
		'_blank'
	);
});

test('shows no help block for a plain webhook (self-explanatory)', () => {
	render(Form, { props: { data: new AlertChannelNewItem({ type: 'webhook' }) } });
	expect(screen.queryByText(/How do I get/i)).toBeNull();
});
