import { test, expect } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import MonitorMap from './index.svelte';

const monitors = [
	{
		id: '1',
		name: 'API',
		status: 'up',
		tags: ['prod'],
		domain: 'api.example.com',
		uptime24h: 99.9
	},
	{ id: '2', name: 'Web', status: 'down', tags: ['prod'], domain: 'example.com', uptime24h: 88 }
] as never;

test('map renders the #280 refinements — legend, search, counter, layout toggle, node metric', () => {
	render(MonitorMap, { props: { monitors, mode: 'tag' } });

	// Extended legend now includes the pending swatch (was up/down/paused only).
	for (const label of ['up', 'down', 'pending', 'paused']) {
		expect(screen.getByText(label)).toBeInTheDocument();
	}
	// Search box + layout toggle.
	expect(screen.getByPlaceholderText(/search monitors/i)).toBeInTheDocument();
	expect(screen.getByRole('button', { name: 'Compact' })).toBeInTheDocument();
	expect(screen.getByRole('button', { name: 'Wide' })).toBeInTheDocument();
	// On-canvas node counter (2 monitors + 1 shared 'prod' hub = 3 nodes).
	expect(screen.getByText(/3 nodes/)).toBeInTheDocument();
	// Monitor node labels + the secondary uptime metric line.
	expect(screen.getByText('API')).toBeInTheDocument();
	expect(screen.getByText('99.9%')).toBeInTheDocument();
});
