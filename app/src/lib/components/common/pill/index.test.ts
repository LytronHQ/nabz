import { render } from '@testing-library/svelte';
import { test, expect } from 'vitest';
import Pill from './index.svelte';

test('maps the friendly tone to its .pill class and renders the label', () => {
	const { container } = render(Pill, { props: { tone: 'pending', label: 'Unverified' } });
	const span = container.querySelector('span.pill');
	expect(span?.classList.contains('pend')).toBe(true);
	expect(span?.textContent?.trim()).toBe('Unverified');
});

test('adds the live class when live is set', () => {
	const { container } = render(Pill, { props: { tone: 'down', label: 'Down', live: true } });
	expect(container.querySelector('span.pill')?.classList.contains('live')).toBe(true);
});
