import { render } from '@testing-library/svelte';
import { beforeAll, describe, expect, it } from 'vitest';
import { CHECKED_ON, COMPETITORS } from './compare';
import { PLANS } from './plans';
import Page from '../routes/compare/[slug]/+page.svelte';

// #683: the comparison pages are honest by construction. nabz's own numbers come
// from plans.ts, every figure about another product names its source and date,
// each page says where the other product is ahead, and none presents confirming
// an outage from several places as something the other product lacks.

beforeAll(() => {
	window.matchMedia ??= ((q: string) => ({
		matches: false,
		media: q,
		addEventListener() {},
		removeEventListener() {}
	})) as unknown as typeof window.matchMedia;
});

const flat = (el: HTMLElement) => el.textContent!.replace(/\s+/g, ' ');
const usd = (n: number) => '$' + String(n);

describe('comparison data', () => {
	it('is dated, sourced, and admits where the other product is ahead', () => {
		expect(COMPETITORS.length).toBeGreaterThan(0);
		expect(CHECKED_ON).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		for (const c of COMPETITORS) {
			expect(c.pricingUrl).toMatch(/^https:\/\//);
			expect(c.confirmation.url).toMatch(/^https:\/\//);
			expect(c.plans.length).toBeGreaterThan(0);
			expect(c.ahead.length).toBeGreaterThan(0);
		}
	});
});

describe('the compare page', () => {
	for (const c of COMPETITORS) {
		it(`nabz vs ${c.name} quotes plans.ts and its sources`, () => {
			const { container } = render(Page, { props: { data: { competitor: c } } as never });
			const text = flat(container);
			expect(text).toContain(`${PLANS.free.monitors} monitors`);
			expect(text).toContain(`${PLANS.pro.monitors} monitors`);
			expect(text).toContain(`${usd(PLANS.pro.priceMonthlyUsd)} a month`);
			expect(text).toContain(`Where ${c.name} is ahead`);
			for (const a of c.ahead) expect(text).toContain(a);
			expect(text).toContain(c.confirmation.text);
			const links = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href'));
			expect(links).toContain(c.pricingUrl);
			expect(links).toContain(c.confirmation.url);
			// Never claim consensus as nabz-only.
			expect(text).not.toMatch(/only nabz|unlike [A-Z]|no other/i);
		});
	}
});
