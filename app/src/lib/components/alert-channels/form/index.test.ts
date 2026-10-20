import { test, expect } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/svelte';

import Test from './index.test.svelte';
import { Form } from '../';
import { AlertChannelNewItem } from '#lib/models/alert-channel.js';

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

test('switching the type swaps the fields, as on the alerts page', async () => {
	// The page passes a class instance held in $state. Svelte 5 does not proxy class
	// instances, so a type change never re-rendered the fields: picking Telegram
	// still showed "Webhook URL" in production.
	const { default: PageLike } = await import('./index.page.test.svelte');
	render(PageLike);
	expect(screen.getByText('Webhook URL')).toBeInTheDocument();
	await fireEvent.change(screen.getByRole('combobox'), { target: { value: 'telegram' } });
	expect(screen.getByText('Bot token')).toBeInTheDocument();
	expect(screen.getByText('Chat ID')).toBeInTheDocument();
	expect(screen.queryByText('Webhook URL')).toBeNull();
});
