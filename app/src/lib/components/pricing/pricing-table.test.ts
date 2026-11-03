import { render } from '@testing-library/svelte';
import { beforeAll, describe, expect, it } from 'vitest';
import PricingTable from './pricing-table.svelte';
import Terms from '../../../routes/terms/+page.svelte';
import Refunds from '../../../routes/refunds/+page.svelte';
import { PLANS, PRO_ON_SALE, formatInterval } from '#lib/plans.js';

// #682: what the pricing page, the terms and the refund policy advertise must be
// what plans.ts enforces. inkla once advertised one limit and enforced another.
const flat = (el: HTMLElement) => el.textContent!.replace(/\s+/g, ' ');
const usd = (n: number) => '$' + String(n);

// The legal pages' theme toggle reads matchMedia, which jsdom does not have.
beforeAll(() => {
	window.matchMedia ??= ((q: string) => ({
		matches: false,
		media: q,
		addEventListener() {},
		removeEventListener() {}
	})) as unknown as typeof window.matchMedia;
});

describe('pricing reads plans.ts', () => {
	it('shows each plan’s numbers', () => {
		const text = flat(render(PricingTable).container);
		for (const p of [PLANS.free, PLANS.pro]) {
			expect(text).toContain(`${p.monitors} monitors`);
			expect(text).toContain(`Checks every ${formatInterval(p.minIntervalSeconds)}`);
			expect(text).toContain(`${p.statusPages} status ${p.statusPages === 1 ? 'page' : 'pages'}`);
		}
		expect(text).toContain(`${usd(PLANS.pro.priceMonthlyUsd)} a month`);
		expect(text).toContain(`${usd(PLANS.pro.priceYearlyUsd)} a year`);
		expect(text).toContain('Incl. VAT / tax where applicable');
		expect(text).toContain('Email, push and webhook alerts');
	});

	it('offers no Pro button while Pro is not on sale', () => {
		const { queryByRole, getByText } = render(PricingTable);
		if (PRO_ON_SALE) return;
		expect(queryByRole('link', { name: 'Get Pro' })).toBeNull();
		expect(getByText(/Not on sale yet/)).toBeTruthy();
	});

	it('the terms and the refund policy quote the same price', () => {
		const price = `${usd(PLANS.pro.priceMonthlyUsd)} a month or ${usd(PLANS.pro.priceYearlyUsd)} a year`;
		for (const page of [Terms, Refunds]) {
			expect(flat(render(page).container)).toContain(price);
		}
	});
});
