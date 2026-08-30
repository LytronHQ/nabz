import { render } from '@testing-library/svelte';
import { test, expect } from 'vitest';
import Icon from './index.svelte';

test('renders the mapped glyph for a known name', () => {
	const { container } = render(Icon, { props: { name: 'plus' } });
	const svg = container.querySelector('svg');
	expect(svg).toBeTruthy();
	expect(svg?.getAttribute('viewBox')).toBe('0 0 24 24');
	expect(svg?.innerHTML).toContain('M12 5v14M5 12h14');
});

test('fill-based icons (play) use fill, not stroke', () => {
	const { container } = render(Icon, { props: { name: 'play' } });
	const svg = container.querySelector('svg');
	expect(svg?.getAttribute('fill')).toBe('currentColor');
	expect(svg?.getAttribute('stroke')).toBe('none');
});

test('renders nothing for an unknown name', () => {
	const { container } = render(Icon, { props: { name: 'nope' as never } });
	expect(container.querySelector('svg')).toBeNull();
});
