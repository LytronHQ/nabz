import { describe, expect, it } from 'vitest';
import { findRefusedWord } from './status-page-words';
import { validateStatusPage } from './status-pages';

// #706: what a public status page on nabz.sh may be called.
const group = (text: string, address = false) => findRefusedWord(text, address)?.group ?? null;

describe('refused words', () => {
	it("refuses nabz's own name anywhere, also joined or with look-alikes", () => {
		expect(group('nabz-status', true)).toBe('nabz');
		expect(group('Nabz Status')).toBe('nabz');
		expect(group('mynabzpage', true)).toBe('nabz');
		expect(group('N4BZ outages')).toBe('nabz');
	});

	it('refuses an address made only of reserved words, not one with a name in it', () => {
		expect(group('support', true)).toBe('reserved');
		expect(group('admin-login', true)).toBe('reserved');
		expect(group('support-status', true)).toBe('reserved');
		expect(group('acme-support', true)).toBeNull();
		// A title may say support; only an address can pass for nabz's own.
		expect(group('Support')).toBeNull();
	});

	it('refuses big brands, joined and with look-alikes', () => {
		expect(group('paypal', true)).toBe('brand');
		expect(group('paypalstatus', true)).toBe('brand');
		expect(group('PayPal is down')).toBe('brand');
		expect(group('P4yp4l status')).toBe('brand');
		expect(group('Stripe payments')).toBe('brand');
		expect(group('Google Cloud')).toBe('brand');
	});

	it('refuses offensive words, plurals and look-alikes', () => {
		expect(group('fuck-this', true)).toBe('offensive');
		expect(group('Sh1t status')).toBe('offensive');
		expect(group('bitches')).toBe('offensive');
	});

	it('leaves ordinary names alone', () => {
		for (const ok of [
			'Acme status',
			'acme-api',
			'Scunthorpe Water',
			'Pineapple Studio',
			'Classic Cars',
			'Essex Dental',
			'Hancock Plumbing',
			'Stripes and Spots',
			'Grapefruit 2024',
			'Weather outlook',
			'cum-laude-academy'
		]) {
			expect(findRefusedWord(ok, true), ok).toBeNull();
		}
	});
});

describe('the status page form', () => {
	const base = { title: 'Acme', slug: 'acme', description: '', monitors: ['m'] };

	it('says which field and why', () => {
		const errors = validateStatusPage({ ...base, title: 'PayPal status', slug: 'nabz' });
		expect(errors.title).toContain('("paypal")');
		expect(errors.title).toContain('support@nabz.sh');
		expect(errors.slug).toBe('"nabz" is the name of this service, so a status page cannot use it.');
		expect(validateStatusPage({ ...base, slug: 'admin' }).slug).toBe(
			'That address is reserved. Add your own name to it, such as acme-admin.'
		);
		expect(validateStatusPage({ ...base, title: 'shit' }).title).toBe(
			'Pick a title without offensive words.'
		);
		expect(validateStatusPage(base)).toEqual({});
	});
});
