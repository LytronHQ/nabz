import type { ListResult, RecordModel } from 'pocketbase';
import { z } from 'zod';
import { type EntityIdType } from '$lib/constants';
import { type IBaseEntity, BaseEntityList, BaseEntityValidator, PaginationData } from './';

export const AlertChannelTypes = [
	'email',
	'webhook',
	'slack',
	'telegram',
	'discord',
	'pagerduty'
] as const;
export type AlertChannelType = (typeof AlertChannelTypes)[number];

// The per-type settings each channel carries (stored in the `config` JSON field).
// A given type reads only the fields it needs; the rest stay empty.
export interface ChannelSettings {
	email: string; // email
	url: string; // webhook, slack, discord
	botToken: string; // telegram
	chatId: string; // telegram
	routingKey: string; // pagerduty
}

const schema = z
	.object({
		type: z.enum(AlertChannelTypes),
		name: z.string().optional().default(''),
		email: z.string().optional().default(''),
		url: z.string().optional().default(''),
		botToken: z.string().optional().default(''),
		chatId: z.string().optional().default(''),
		routingKey: z.string().optional().default('')
	})
	// Each type validates only its own fields.
	.superRefine((val, ctx) => {
		const require = (field: keyof ChannelSettings, message: string): boolean => {
			if (!String(val[field] ?? '').trim()) {
				ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message });
				return false;
			}
			return true;
		};
		const match = (field: keyof ChannelSettings, re: RegExp, message: string) => {
			const v = String(val[field] ?? '').trim();
			if (v && !re.test(v)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message });
		};

		switch (val.type) {
			case 'email':
				if (require('email', 'Email address is required'))
					match('email', /^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Enter a valid email address');
				break;
			case 'webhook':
				if (require('url', 'Webhook URL is required'))
					match('url', /^https?:\/\//, 'Must be an http(s) URL');
				break;
			case 'slack':
				if (require('url', 'Slack webhook URL is required'))
					match(
						'url',
						/^https:\/\/hooks\.slack\.com\//,
						'Must be a Slack incoming webhook URL (https://hooks.slack.com/…)'
					);
				break;
			case 'discord':
				if (require('url', 'Discord webhook URL is required'))
					match(
						'url',
						/^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//,
						'Must be a Discord webhook URL (https://discord.com/api/webhooks/…)'
					);
				break;
			case 'telegram':
				if (require('botToken', 'Bot token is required'))
					match('botToken', /^\d+:[A-Za-z0-9_-]+$/, 'Looks like 123456:ABC-DEF1234ghIkl…');
				if (require('chatId', 'Chat ID is required'))
					match(
						'chatId',
						/^(-?\d+|@[A-Za-z0-9_]+)$/,
						'A numeric id (e.g. -1001234567890) or @channelusername'
					);
				break;
			case 'pagerduty':
				require('routingKey', 'Integration routing key is required');
				break;
		}
	});

export type IAlertChannelItem = z.infer<typeof schema>;

function toBool(value: any): boolean {
	return value === true || value === 'true' || value === 1 || value === '1';
}

// channelSettings resolves the per-type fields from any source: a submitted form
// (flat fields), a PocketBase record (nested `config`), or a legacy record that
// stored everything in the single `target` string.
function channelSettings(item: any): ChannelSettings {
	const cfg = item.config ?? {};
	const s: ChannelSettings = {
		email: item.email ?? cfg.email ?? '',
		url: item.url ?? cfg.url ?? '',
		botToken: item.botToken ?? cfg.botToken ?? '',
		chatId: item.chatId ?? cfg.chatId ?? '',
		routingKey: item.routingKey ?? cfg.routingKey ?? ''
	};
	// Legacy channels predate `config` and kept their destination in `target`.
	const target: string = item.target ?? '';
	const empty = !s.email && !s.url && !s.botToken && !s.chatId && !s.routingKey;
	if (target && empty) {
		switch (item.type) {
			case 'email':
				s.email = target;
				break;
			case 'webhook':
			case 'slack':
			case 'discord':
				s.url = target;
				break;
			case 'pagerduty':
				s.routingKey = target;
				break;
			case 'telegram': {
				const i = target.lastIndexOf(':');
				if (i > 0) {
					s.botToken = target.slice(0, i);
					s.chatId = target.slice(i + 1);
				}
				break;
			}
		}
	}
	return s;
}

// toChannelConfig builds the `config` object to persist for a channel, keeping
// only the fields its type uses.
export function toChannelConfig(
	item: { type: AlertChannelType } & Partial<ChannelSettings>
): Partial<ChannelSettings> {
	switch (item.type) {
		case 'email':
			return { email: item.email };
		case 'webhook':
		case 'slack':
		case 'discord':
			return { url: item.url };
		case 'telegram':
			return { botToken: item.botToken, chatId: item.chatId };
		case 'pagerduty':
			return { routingKey: item.routingKey };
		default:
			return {};
	}
}

export class AlertChannelItem implements IBaseEntity, ChannelSettings {
	id: EntityIdType;
	type: AlertChannelType;
	name: string;
	enabled: boolean;
	email: string;
	url: string;
	botToken: string;
	chatId: string;
	routingKey: string;

	constructor(data: FormData | RecordModel | any) {
		const item = data instanceof FormData ? Object.fromEntries(data) : (data ?? {});
		const s = channelSettings(item);
		this.id = item.id;
		this.type = item.type ?? 'webhook';
		this.name = (item.name ?? '').trim();
		this.enabled = toBool(item.enabled);
		this.email = s.email;
		this.url = s.url;
		this.botToken = s.botToken;
		this.chatId = s.chatId;
		this.routingKey = s.routingKey;
	}
}

export class AlertChannelNewItem implements ChannelSettings {
	type: AlertChannelType;
	name: string;
	enabled: boolean;
	email: string;
	url: string;
	botToken: string;
	chatId: string;
	routingKey: string;

	constructor(data: FormData | RecordModel | any = null) {
		const fromForm = data instanceof FormData;
		const item = fromForm ? Object.fromEntries(data) : (data ?? {});
		const s = channelSettings(item);
		this.type = item.type ?? 'webhook';
		this.name = (item.name ?? '').trim();
		this.enabled = fromForm ? toBool(item.enabled) : (item.enabled ?? true);
		this.email = s.email;
		this.url = s.url;
		this.botToken = s.botToken;
		this.chatId = s.chatId;
		this.routingKey = s.routingKey;
	}
}

export class AlertChannelItemValidator extends BaseEntityValidator {
	constructor(item: AlertChannelItem | AlertChannelNewItem) {
		super(schema, item);
	}
}

export class AlertChannelsList extends BaseEntityList<AlertChannelItem> {
	constructor(data: AlertChannelsList);
	constructor(data: ListResult<RecordModel> | any) {
		super(
			data instanceof AlertChannelsList
				? data.items
				: data.items.map((it: any) => new AlertChannelItem(it)),
			data instanceof AlertChannelsList
				? new PaginationData(data.pagination)
				: new PaginationData(data)
		);
	}

	add(item: any) {
		super.add(new AlertChannelItem(item));
		return this;
	}

	edit(item: any) {
		super.edit(new AlertChannelItem(item));
		return this;
	}

	remove(id: EntityIdType) {
		super.remove(id);
		return this;
	}
}
