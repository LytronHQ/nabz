import { describe, it, expect } from 'vitest';
import { orderZones, zoneName, nameZonesInText } from './zone-order';

const labels = {
	'eu-central': { label: 'Europe', sortOrder: 10 },
	'ap-southeast': { label: 'Asia', sortOrder: 20 }
};

describe('orderZones (#558)', () => {
	it('gives the same order whatever order the evaluator wrote', () => {
		expect(orderZones(['ap-southeast', 'eu-central'], labels)).toEqual([
			'eu-central',
			'ap-southeast'
		]);
		expect(orderZones(['eu-central', 'ap-southeast'], labels)).toEqual([
			'eu-central',
			'ap-southeast'
		]);
	});

	it('puts unlabelled zones last, by code', () => {
		expect(orderZones(['zz', 'ap-southeast', 'aa', 'eu-central'], labels)).toEqual([
			'eu-central',
			'ap-southeast',
			'aa',
			'zz'
		]);
	});

	it('does not reorder its input in place', () => {
		const input = ['ap-southeast', 'eu-central'];
		orderZones(input, labels);
		expect(input).toEqual(['ap-southeast', 'eu-central']);
	});
});

describe('zoneName', () => {
	it('uses the label, falling back to the code', () => {
		expect(zoneName('eu-central', labels)).toBe('Europe');
		expect(zoneName('us-east', labels)).toBe('us-east');
	});
});

describe('nameZonesInText (#560)', () => {
	it('names the zones in an evaluator cause', () => {
		expect(nameZonesInText('down in eu-central, ap-southeast', labels)).toBe(
			'down in Europe, Asia'
		);
		expect(nameZonesInText('Incident opened — down in ap-southeast', labels)).toBe(
			'Incident opened — down in Asia'
		);
	});

	it('leaves unlabelled codes and other text alone', () => {
		expect(nameZonesInText('down in us-east', labels)).toBe('down in us-east');
		expect(nameZonesInText('down', labels)).toBe('down');
		expect(nameZonesInText('Acknowledged by sam', labels)).toBe('Acknowledged by sam');
	});
});
