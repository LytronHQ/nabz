import { render } from '@testing-library/svelte';
import { test, expect } from 'vitest';
import PageHeader from './index.svelte';

test('renders the title and sub', () => {
	const { container } = render(PageHeader, { props: { title: 'Monitors', sub: '3 monitors' } });
	expect(container.querySelector('h1')?.textContent).toBe('Monitors');
	expect(container.querySelector('.sub')?.textContent).toBe('3 monitors');
});

test('omits the sub line when not provided', () => {
	const { container } = render(PageHeader, { props: { title: 'Account' } });
	expect(container.querySelector('h1')?.textContent).toBe('Account');
	expect(container.querySelector('.sub')).toBeNull();
	// No actions slot -> no toolbar.
	expect(container.querySelector('.toolbar')).toBeNull();
});
