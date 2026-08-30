import type { ListResult, RecordModel } from 'pocketbase';
import { z } from 'zod';
import { type EntityIdType } from '$lib/constants';
import { type IBaseEntity, BaseEntityList, BaseEntityValidator, PaginationData } from './';

export const MonitorTypes = ['website', 'ping', 'port', 'heartbeat', 'duplicati', 'dns'] as const;
export type MonitorType = (typeof MonitorTypes)[number];

// The monitor types the worker can actually run today. The others exist in the
// enum (schema + roadmap) but must not be creatable until their worker
// implementation lands — otherwise a user can create a monitor that only ever
// reports "unsupported monitor type" (issue #82). This is the single source of
// truth: as each type ships, add it here and it re-enables in both the form
// (selectable) and the API (accepted by the validator below).
export const SupportedMonitorTypes = [
	'website',
	'port',
	'ping',
	'heartbeat',
	'dns'
] as const satisfies readonly MonitorType[];

export function isSupportedMonitorType(type: string): boolean {
	return (SupportedMonitorTypes as readonly string[]).includes(type);
}

// Parse a "Name: Value" per-line headers textarea into a map (blank lines and
// lines without a colon are ignored).
export function parseHeaders(raw: string | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of (raw ?? '').split('\n')) {
		const i = line.indexOf(':');
		if (i <= 0) continue;
		const k = line.slice(0, i).trim();
		const v = line.slice(i + 1).trim();
		if (k) out[k] = v;
	}
	return out;
}

// Render a headers map back into the "Name: Value" per-line textarea form.
export function headersToLines(headers: Record<string, string> | undefined | null): string {
	if (!headers) return '';
	return Object.entries(headers)
		.map(([k, v]) => `${k}: ${v}`)
		.join('\n');
}

function toPositiveInt(value: any): number | null {
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

// Assemble the monitor `config` JSON from the flat form fields, or null when
// nothing non-default is set. Every field is omitted at its default so an unset
// config keeps the original behaviour (GET, 200–399 = up, follow redirects).
export function toMonitorConfig(item: any): Record<string, unknown> | null {
	const cfg: Record<string, unknown> = {};

	if (item.keywordMode === 'contains' || item.keywordMode === 'absent') {
		cfg.keyword = (item.keyword ?? '').trim();
		cfg.keywordMode = item.keywordMode;
	}

	const method = (item.method ?? '').toString().toUpperCase();
	if (method && method !== 'GET') cfg.method = method;

	const headers = parseHeaders(item.headers);
	if (Object.keys(headers).length) cfg.headers = headers;

	const expected = toPositiveInt(item.expectedStatus);
	if (expected) cfg.expectedStatus = expected;

	// Default is to follow; only persist the opt-out.
	if (item.followRedirects === false || item.followRedirects === 'false')
		cfg.followRedirects = false;

	const timeout = toPositiveInt(item.timeoutSecs);
	if (timeout) cfg.timeoutSecs = timeout;

	const windows = toWindows(item.maintenanceWindows);
	if (windows.length) cfg.maintenanceWindows = windows;

	const latency = toPositiveInt(item.latencyThresholdMs);
	if (latency) cfg.latencyThresholdMs = latency;

	// DNS options (only persisted for dns monitors, and only when non-default).
	const dnsRecordType = (item.dnsRecordType ?? '').toString().trim().toUpperCase();
	if (dnsRecordType && dnsRecordType !== 'A') cfg.dnsRecordType = dnsRecordType;
	const dnsExpectedValue = (item.dnsExpectedValue ?? '').toString().trim();
	if (dnsExpectedValue) cfg.dnsExpectedValue = dnsExpectedValue;
	const dnsResolver = (item.dnsResolver ?? '').toString().trim();
	if (dnsResolver) cfg.dnsResolver = dnsResolver;

	return Object.keys(cfg).length ? cfg : null;
}

export const MonitorStatuses = ['up', 'down', 'pending', 'paused'] as const;
export type MonitorStatus = (typeof MonitorStatuses)[number];

const schema = z
	.object({
		name: z.string().min(1, 'Name is required'),
		type: z.enum(MonitorTypes).refine(isSupportedMonitorType, {
			message: 'This monitor type is not available yet'
		}),
		target: z.string().optional().default(''),
		// Must match infrastructure/pb_schema.json's monitors.interval min and
		// corelib's models.MinIntervalSeconds (#319). If this floor is lower than
		// the schema's, the API accepts an interval PocketBase then rejects, and
		// the user gets an opaque 500 instead of this field message.
		interval: z.coerce.number().int().min(30, 'Interval must be at least 30 seconds'),
		keyword: z.string().optional(),
		keywordMode: z.string().optional(),
		method: z.string().optional(),
		headers: z.string().optional(),
		expectedStatus: z.union([z.number(), z.null()]).optional(),
		followRedirects: z.union([z.boolean(), z.string()]).optional(),
		timeoutSecs: z.union([z.number(), z.null()]).optional(),
		maintenanceWindows: z.array(z.any()).optional(),
		latencyThresholdMs: z.union([z.number(), z.null()]).optional(),
		dnsRecordType: z.string().optional(),
		dnsExpectedValue: z.string().optional(),
		dnsResolver: z.string().optional()
	})
	// A `port` monitor is a TCP connect, so it needs an explicit host:port —
	// otherwise the worker can't dial it and the monitor would sit down forever.
	.superRefine((val, ctx) => {
		// Probed types need a target to reach; a heartbeat is reached the other
		// way (the job checks in), so it has none.
		if (val.type !== 'heartbeat' && !(val.target ?? '').trim()) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['target'],
				message: 'Target is required'
			});
		}
		if (val.type === 'port') {
			const m = /^(.+):(\d{1,5})$/.exec((val.target ?? '').trim());
			const port = m ? Number(m[2]) : NaN;
			if (!m || port < 1 || port > 65535) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ['target'],
					message: 'Enter host:port (e.g. example.com:443)'
				});
			}
		}
		// A body assertion needs the text to look for.
		if (
			(val.keywordMode === 'contains' || val.keywordMode === 'absent') &&
			!(val.keyword ?? '').trim()
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['keyword'],
				message: 'Enter the text to check for'
			});
		}
		if (val.expectedStatus != null && (val.expectedStatus < 100 || val.expectedStatus > 599)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['expectedStatus'],
				message: 'Status code must be 100–599'
			});
		}
		if (val.timeoutSecs != null && (val.timeoutSecs < 1 || val.timeoutSecs > 120)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['timeoutSecs'],
				message: 'Timeout must be 1–120 seconds'
			});
		}
		if (val.latencyThresholdMs != null && val.latencyThresholdMs < 1) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['latencyThresholdMs'],
				message: 'Threshold must be a positive number of milliseconds'
			});
		}
	});

export type IMonitorItem = z.infer<typeof schema>;

function toInterval(value: any): number {
	const n = Number(value);
	return Number.isFinite(n) ? Math.trunc(n) : 60;
}

function toBool(value: any): boolean {
	return value === true || value === 'true' || value === 1 || value === '1';
}

function toZones(value: any): string[] {
	if (Array.isArray(value)) return value.filter(Boolean);
	if (typeof value === 'string')
		return value
			.split(',')
			.map((z) => z.trim())
			.filter(Boolean);
	return [];
}

function toNumberOrNull(value: any): number | null {
	if (value === undefined || value === null || value === '') return null;
	const n = Number(value);
	return Number.isFinite(n) ? n : null;
}

export type MaintenanceWindow = { start: string; end: string };

// Accept maintenance windows as an array (API record) or a JSON string (round-
// tripped through FormData); keep only entries with both a start and an end.
export function toWindows(value: any): MaintenanceWindow[] {
	let arr = value;
	if (typeof value === 'string' && value.trim()) {
		try {
			arr = JSON.parse(value);
		} catch {
			return [];
		}
	}
	if (!Array.isArray(arr)) return [];
	return arr.filter((w) => w && w.start && w.end).map((w) => ({ start: w.start, end: w.end }));
}

// Read the HTTP-option fields from either an API record (nested `config` object)
// or flat form fields, defaulting each to its original behaviour when unset.
function configFields(item: any) {
	const c = item.config;
	return {
		keyword: c?.keyword ?? item.keyword ?? '',
		keywordMode: c?.keywordMode ?? item.keywordMode ?? '',
		method: c?.method ?? item.method ?? 'GET',
		headers: c?.headers ? headersToLines(c.headers) : (item.headers ?? ''),
		expectedStatus: toNumberOrNull(c?.expectedStatus ?? item.expectedStatus),
		followRedirects: c
			? (c.followRedirects ?? true)
			: item.followRedirects !== undefined
				? toBool(item.followRedirects)
				: true,
		timeoutSecs: toNumberOrNull(c?.timeoutSecs ?? item.timeoutSecs),
		maintenanceWindows: toWindows(c?.maintenanceWindows ?? item.maintenanceWindows),
		latencyThresholdMs: toNumberOrNull(c?.latencyThresholdMs ?? item.latencyThresholdMs),
		dnsRecordType: c?.dnsRecordType ?? item.dnsRecordType ?? 'A',
		dnsExpectedValue: c?.dnsExpectedValue ?? item.dnsExpectedValue ?? '',
		dnsResolver: c?.dnsResolver ?? item.dnsResolver ?? ''
	};
}

export class MonitorItem implements IBaseEntity {
	id: EntityIdType;
	name: string;
	type: MonitorType;
	target: string;
	interval: number;
	enabled: boolean;
	zones: string[];
	tags: string[];
	escalationPolicy: string;
	// Per-monitor HTTP options (stored in the monitor `config` JSON).
	keyword: string;
	keywordMode: string;
	method: string;
	headers: string;
	expectedStatus: number | null;
	followRedirects: boolean;
	timeoutSecs: number | null;
	maintenanceWindows: MaintenanceWindow[];
	latencyThresholdMs: number | null;
	dnsRecordType: string;
	dnsExpectedValue: string;
	dnsResolver: string;
	// Read-only display fields (written by the worker / evaluator, enriched by the API).
	status: MonitorStatus;
	// What the evaluator's last verdict was actually taken on (#328): the zones
	// that took part, and the subset that had a fresh check and therefore voted.
	// Read-only, and deliberately not re-derived here — freshness depends on the
	// monitor's effective interval inside the evaluator, so any second guess
	// drifts from the decision that was really made.
	consensusZones: string[];
	consensusFresh: string[];
	lastChecked: string | null;
	uptime24h: number | null;
	certExpiresAt: string | null;
	// When the target's DOMAIN registration lapses — an infrequent, cached
	// RDAP/WHOIS lookup the evaluator runs (distinct from the TLS cert above).
	// Null when unknown (no data, non-domain target, or not yet looked up).
	domainExpiresAt: string | null;
	// When the monitor most recently went down (latest incident's start), or null if
	// it has no incidents on record. Enriched by the list API from the `incidents`
	// collection (#279).
	lastDowntime: string | null;
	// Heartbeat check-in token (empty for probed types); used to build the /ping URL.
	token: string;

	constructor(data: FormData | RecordModel | any) {
		const item = data instanceof FormData ? Object.fromEntries(data) : (data ?? {});
		this.id = item.id;
		this.name = item.name ?? '';
		this.type = item.type ?? 'website';
		this.target = item.target ?? '';
		this.token = item.token ?? '';
		this.interval = toInterval(item.interval);
		this.enabled = toBool(item.enabled);
		this.zones = toZones(item.zones);
		this.tags = toZones(item.tags);
		this.escalationPolicy = item.escalation_policy ?? item.escalationPolicy ?? '';
		const cf = configFields(item);
		this.keyword = cf.keyword;
		this.keywordMode = cf.keywordMode;
		this.method = cf.method;
		this.headers = cf.headers;
		this.expectedStatus = cf.expectedStatus;
		this.followRedirects = cf.followRedirects;
		this.timeoutSecs = cf.timeoutSecs;
		this.maintenanceWindows = cf.maintenanceWindows;
		this.latencyThresholdMs = cf.latencyThresholdMs;
		this.dnsRecordType = cf.dnsRecordType;
		this.dnsExpectedValue = cf.dnsExpectedValue;
		this.dnsResolver = cf.dnsResolver;
		// A disabled monitor isn't scheduled (worker/evaluator filter enabled=true),
		// so the backend never writes 'paused' — its stored status just goes stale.
		// Surface "paused" from `enabled` here so every view reflects it consistently.
		this.status = this.enabled ? (item.status ?? 'pending') : 'paused';
		this.consensusZones = toZones(item.consensus_zones ?? item.consensusZones);
		this.consensusFresh = toZones(item.consensus_fresh ?? item.consensusFresh);
		this.lastChecked = item.last_checked ?? item.lastChecked ?? null;
		this.uptime24h = toNumberOrNull(item.uptime24h);
		this.certExpiresAt = item.cert_expires_at ?? item.certExpiresAt ?? null;
		this.domainExpiresAt = item.domain_expires_at ?? item.domainExpiresAt ?? null;
		this.lastDowntime = item.lastDowntime ?? item.last_downtime ?? null;
	}
}

export class MonitorNewItem {
	name: string;
	type: MonitorType;
	target: string;
	interval: number;
	enabled: boolean;
	zones: string[];
	tags: string[];
	escalationPolicy: string;
	keyword: string;
	keywordMode: string;
	method: string;
	headers: string;
	expectedStatus: number | null;
	followRedirects: boolean;
	timeoutSecs: number | null;
	maintenanceWindows: MaintenanceWindow[];
	latencyThresholdMs: number | null;
	dnsRecordType: string;
	dnsExpectedValue: string;
	dnsResolver: string;

	constructor(data: FormData | RecordModel | any = null) {
		const fromForm = data instanceof FormData;
		const item = fromForm ? Object.fromEntries(data) : (data ?? {});
		this.name = item.name ?? '';
		this.type = item.type ?? 'website';
		this.target = item.target ?? '';
		this.interval = item.interval !== undefined ? toInterval(item.interval) : 60;
		this.enabled = fromForm ? toBool(item.enabled) : (item.enabled ?? true);
		this.zones = toZones(item.zones);
		this.tags = toZones(item.tags);
		this.escalationPolicy = item.escalation_policy ?? item.escalationPolicy ?? '';
		const cf = configFields(item);
		this.keyword = cf.keyword;
		this.keywordMode = cf.keywordMode;
		this.method = cf.method;
		this.headers = cf.headers;
		this.expectedStatus = cf.expectedStatus;
		this.followRedirects = cf.followRedirects;
		this.timeoutSecs = cf.timeoutSecs;
		this.maintenanceWindows = cf.maintenanceWindows;
		this.latencyThresholdMs = cf.latencyThresholdMs;
		this.dnsRecordType = cf.dnsRecordType;
		this.dnsExpectedValue = cf.dnsExpectedValue;
		this.dnsResolver = cf.dnsResolver;
	}
}

export class MonitorItemValidator extends BaseEntityValidator {
	constructor(item: MonitorItem | MonitorNewItem) {
		super(schema, item);
	}
}

export class MonitorsList extends BaseEntityList<MonitorItem> {
	constructor(data: MonitorsList);
	constructor(data: ListResult<RecordModel> | any) {
		// Guard against the uninitialised shared store (`{}`), which has no
		// `.items`: on the monitor detail page `store.edit()` updates this store
		// before the list page has ever populated it — without the guard
		// `data.items.map` throws, the modal's submit rejects, and it never closes.
		super(
			data instanceof MonitorsList
				? data.items
				: (data?.items ?? []).map((it: any) => new MonitorItem(it)),
			data instanceof MonitorsList
				? new PaginationData(data.pagination)
				: new PaginationData(data ?? {})
		);
	}

	add(item: any) {
		super.add(new MonitorItem(item));
		return this;
	}

	edit(item: any) {
		super.edit(new MonitorItem(item));
		return this;
	}

	remove(id: EntityIdType) {
		super.remove(id);
		return this;
	}
}
