import { test, expect } from 'vitest';
import { registrableDomain } from './domain';

test('reduces hosts to the registrable (eTLD+1) domain', () => {
	const cases: [string, string | null][] = [
		['example.com', 'example.com'],
		['api.example.com', 'example.com'],
		['a.b.c.example.com', 'example.com'],
		['https://api.example.co.uk/health', 'example.co.uk'],
		['shop.example.com.au', 'example.com.au'],
		['example.co.uk', 'example.co.uk'],
		['db.example.org:5432', 'example.org'],
		['http://example.com', 'example.com'],
		['API.Example.COM.', 'example.com']
	];
	for (const [input, want] of cases) {
		expect(registrableDomain(input)).toBe(want);
	}
});

test('returns null for hosts with no registrable domain', () => {
	for (const t of [
		'',
		'192.168.1.10',
		'10.0.0.1:8080',
		'http://127.0.0.1:3000/x',
		'localhost',
		'localhost:8080'
	]) {
		expect(registrableDomain(t)).toBeNull();
	}
});
