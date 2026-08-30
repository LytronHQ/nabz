import { test, expect } from 'vitest';
import {
	MonitorTypes,
	SupportedMonitorTypes,
	isSupportedMonitorType,
	MonitorNewItem,
	MonitorItemValidator,
	toMonitorConfig,
	parseHeaders,
	headersToLines,
	toWindows
} from '$lib/models/monitor';

test('every supported type is a valid monitor type', () => {
	for (const t of SupportedMonitorTypes) {
		expect(MonitorTypes).toContain(t);
	}
});

test('isSupportedMonitorType: only implemented types are supported', () => {
	for (const t of ['website', 'port', 'ping', 'heartbeat', 'dns']) {
		expect(isSupportedMonitorType(t)).toBe(true);
	}
	// The still-stubbed type must not be supported until its worker code lands.
	for (const t of ['duplicati']) {
		expect(isSupportedMonitorType(t)).toBe(false);
	}
});

test('validator accepts a website monitor', () => {
	const item = new MonitorNewItem({
		name: 'Site',
		type: 'website',
		target: 'https://example.com',
		interval: 60
	});
	expect(new MonitorItemValidator(item).isValid).toBe(true);
});

test('port monitor requires host:port on the target field', () => {
	const bad = new MonitorNewItem({ name: 'db', type: 'port', target: 'example.com', interval: 60 });
	const badValidator = new MonitorItemValidator(bad);
	expect(badValidator.isValid).toBe(false);
	expect(badValidator.validationErrors?.some((e) => e.field === 'target')).toBe(true);

	const good = new MonitorNewItem({
		name: 'db',
		type: 'port',
		target: 'example.com:5432',
		interval: 60
	});
	expect(new MonitorItemValidator(good).isValid).toBe(true);
});

test('a body assertion requires the keyword text', () => {
	const missing = new MonitorNewItem({
		name: 's',
		type: 'website',
		target: 'https://x.com',
		interval: 60,
		keywordMode: 'contains',
		keyword: ''
	});
	const v = new MonitorItemValidator(missing);
	expect(v.isValid).toBe(false);
	expect(v.validationErrors?.some((e) => e.field === 'keyword')).toBe(true);

	const ok = new MonitorNewItem({
		name: 's',
		type: 'website',
		target: 'https://x.com',
		interval: 60,
		keywordMode: 'contains',
		keyword: 'Welcome'
	});
	expect(new MonitorItemValidator(ok).isValid).toBe(true);
});

test('toMonitorConfig builds config only when a mode is set', () => {
	expect(toMonitorConfig({ keywordMode: '', keyword: 'x' })).toBeNull();
	expect(toMonitorConfig({})).toBeNull();
	expect(toMonitorConfig({ keywordMode: 'contains', keyword: '  Welcome  ' })).toEqual({
		keyword: 'Welcome',
		keywordMode: 'contains'
	});
	expect(toMonitorConfig({ keywordMode: 'absent', keyword: 'error' })).toEqual({
		keyword: 'error',
		keywordMode: 'absent'
	});
});

test('parseHeaders / headersToLines round-trip', () => {
	const raw = 'X-Api-Key: secret\nAccept: application/json\nbadline\n';
	expect(parseHeaders(raw)).toEqual({ 'X-Api-Key': 'secret', Accept: 'application/json' });
	expect(headersToLines({ 'X-Api-Key': 'secret' })).toBe('X-Api-Key: secret');
	expect(parseHeaders('')).toEqual({});
	expect(headersToLines(undefined)).toBe('');
});

test('toMonitorConfig assembles HTTP options and omits defaults', () => {
	// All defaults -> null.
	expect(toMonitorConfig({ method: 'GET', headers: '', followRedirects: true })).toBeNull();

	expect(
		toMonitorConfig({
			method: 'head',
			headers: 'X-Api-Key: secret',
			expectedStatus: 204,
			followRedirects: false,
			timeoutSecs: 5
		})
	).toEqual({
		method: 'HEAD',
		headers: { 'X-Api-Key': 'secret' },
		expectedStatus: 204,
		followRedirects: false,
		timeoutSecs: 5
	});

	// followRedirects default (true) is not persisted.
	expect(toMonitorConfig({ expectedStatus: 200, followRedirects: true })).toEqual({
		expectedStatus: 200
	});
});

test('validator rejects out-of-range expected status and timeout', () => {
	const badStatus = new MonitorNewItem({
		name: 's',
		type: 'website',
		target: 'https://x.com',
		interval: 60,
		expectedStatus: 999
	});
	const v1 = new MonitorItemValidator(badStatus);
	expect(v1.isValid).toBe(false);
	expect(v1.validationErrors?.some((e) => e.field === 'expectedStatus')).toBe(true);

	const badTimeout = new MonitorNewItem({
		name: 's',
		type: 'website',
		target: 'https://x.com',
		interval: 60,
		timeoutSecs: 999
	});
	const v2 = new MonitorItemValidator(badTimeout);
	expect(v2.isValid).toBe(false);
	expect(v2.validationErrors?.some((e) => e.field === 'timeoutSecs')).toBe(true);

	const ok = new MonitorNewItem({
		name: 's',
		type: 'website',
		target: 'https://x.com',
		interval: 60,
		expectedStatus: 204,
		timeoutSecs: 10
	});
	expect(new MonitorItemValidator(ok).isValid).toBe(true);
});

test('maintenance windows: toWindows parses arrays + JSON, drops invalid; config round-trips', () => {
	const w = [{ start: '2026-08-01T00:00:00.000Z', end: '2026-08-01T01:00:00.000Z' }];
	expect(toWindows(w)).toEqual(w);
	expect(toWindows(JSON.stringify(w))).toEqual(w); // FormData round-trip
	expect(toWindows([{ start: 'a', end: 'b' }, { start: 'only-start' }])).toEqual([
		{ start: 'a', end: 'b' }
	]);
	expect(toWindows(undefined)).toEqual([]);
	expect(toMonitorConfig({ maintenanceWindows: w })).toEqual({ maintenanceWindows: w });
});

test('tags parse from an array or a comma-separated string', () => {
	expect(
		new MonitorNewItem({
			name: 'x',
			type: 'website',
			target: 'https://x.com',
			interval: 60,
			tags: ['prod', 'db']
		}).tags
	).toEqual(['prod', 'db']);
	expect(new MonitorNewItem({ tags: 'prod, db ,  , api' } as any).tags).toEqual([
		'prod',
		'db',
		'api'
	]);
	expect(new MonitorNewItem({} as any).tags).toEqual([]);
});

test('latency threshold: config round-trip + positive validation', () => {
	expect(toMonitorConfig({ latencyThresholdMs: 800 })).toEqual({ latencyThresholdMs: 800 });
	expect(toMonitorConfig({ latencyThresholdMs: 0 })).toBeNull();

	const bad = new MonitorNewItem({
		name: 's',
		type: 'website',
		target: 'https://x.com',
		interval: 60,
		latencyThresholdMs: -5
	});
	const v = new MonitorItemValidator(bad);
	expect(v.isValid).toBe(false);
	expect(v.validationErrors?.some((e) => e.field === 'latencyThresholdMs')).toBe(true);

	const ok = new MonitorNewItem({
		name: 's',
		type: 'website',
		target: 'https://x.com',
		interval: 60,
		latencyThresholdMs: 500
	});
	expect(new MonitorItemValidator(ok).isValid).toBe(true);
});

test('validator rejects an unimplemented type with a type-field error', () => {
	const item = new MonitorNewItem({
		name: 'Backup',
		type: 'duplicati',
		target: 'my-machine',
		interval: 60
	});
	const validator = new MonitorItemValidator(item);
	expect(validator.isValid).toBe(false);
	expect(validator.validationErrors?.some((e) => e.field === 'type')).toBe(true);
});

test('validator accepts a heartbeat monitor with no target', () => {
	// A heartbeat has no probe target — the job checks in to /ping/{token}.
	const item = new MonitorNewItem({ name: 'Cron job', type: 'heartbeat', interval: 60 });
	expect(new MonitorItemValidator(item).isValid).toBe(true);
});

test('validator accepts a dns monitor with a hostname', () => {
	const item = new MonitorNewItem({
		name: 'DNS',
		type: 'dns',
		target: 'example.com',
		interval: 60
	});
	expect(new MonitorItemValidator(item).isValid).toBe(true);
});

test('toMonitorConfig persists non-default DNS options only', () => {
	const item = new MonitorNewItem({
		name: 'DNS',
		type: 'dns',
		target: 'example.com',
		interval: 60,
		dnsRecordType: 'MX',
		dnsExpectedValue: 'aspmx.l.google.com',
		dnsResolver: '8.8.8.8'
	});
	const cfg = toMonitorConfig(item) as any;
	expect(cfg.dnsRecordType).toBe('MX');
	expect(cfg.dnsExpectedValue).toBe('aspmx.l.google.com');
	expect(cfg.dnsResolver).toBe('8.8.8.8');
	// The default A record type is not persisted.
	const a = new MonitorNewItem({
		name: 'DNS',
		type: 'dns',
		target: 'example.com',
		interval: 60,
		dnsRecordType: 'A'
	});
	expect((toMonitorConfig(a) as any)?.dnsRecordType).toBeUndefined();
});
