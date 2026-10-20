// How an alert channel reads in lists and escalation policies (#144).
//
// Targets (webhook URLs, API keys) are secrets — never render them in full, since
// screenshots leak them. `channelTarget` returns just enough to keep a channel
// identifiable; the full value lives in the Edit form. `channelDisplayName` prefers
// the channel's optional human Name, falling back to "provider · target".

import type { ChannelSettings } from '#lib/models/alert-channel.js';

function hostTail(url: string): string {
	if (!url) return '';
	try {
		const host = new URL(url).host;
		const tail = url.replace(/\/+$/, '').slice(-6);
		return `${host} · …${tail}`;
	} catch {
		return url.length > 34 ? `${url.slice(0, 16)}…${url.slice(-6)}` : url;
	}
}

function mask(secret: string): string {
	if (!secret) return '';
	return secret.length > 10 ? `${secret.slice(0, 4)}…${secret.slice(-4)}` : '••••';
}

/** The type-specific, secret-safe target snippet for a channel (no provider prefix). */
// A channel as any view holds it: an AlertChannelItem, or a record with the same
// flat per-type fields.
type ChannelLike = Partial<ChannelSettings> & { type: string; name?: string };

export function channelTarget(item: ChannelLike): string {
	switch (item.type) {
		case 'email':
			return item.email ?? '';
		case 'webhook':
		case 'slack':
		case 'discord':
			return hostTail(item.url ?? '');
		case 'telegram':
			return item.chatId ? `chat ${item.chatId}` : '';
		case 'pagerduty':
			return mask(item.routingKey ?? '');
		case 'push':
			return pushService(item.endpoint ?? '');
		default:
			return '';
	}
}

// A push endpoint is a capability URL (anyone holding it can address the device),
// so only the push service is shown: the browser and whose service carries it.
// It says nothing about the operating system: Edge uses Microsoft's service on
// Linux and macOS too, and an Edge on Linux was labelled "Windows device".
const PUSH_SERVICES: [RegExp, string][] = [
	[/(^|\.)fcm\.googleapis\.com$/, 'Chrome / Android (Google push)'],
	// Chromium builds without Google's branding subscribe through *.google.com.
	[/(^|\.)google\.com$/, 'Chromium (Google push)'],
	[/(^|\.)push\.apple\.com$/, 'Safari / iPhone (Apple push)'],
	[/(^|\.)push\.services\.mozilla\.com$/, 'Firefox (Mozilla push)'],
	[/(^|\.)notify\.windows\.com$/, 'Edge (Microsoft push)']
];

function pushService(endpoint: string): string {
	if (!endpoint) return 'no device yet';
	try {
		const host = new URL(endpoint).host;
		return PUSH_SERVICES.find(([re]) => re.test(host))?.[1] ?? host;
	} catch {
		return 'device';
	}
}

/**
 * How a channel is labelled where it's referenced (e.g. escalation-policy levels):
 * its Name when set, otherwise "provider · target".
 */
export function channelDisplayName(item: ChannelLike): string {
	const name = (item.name ?? '').trim();
	if (name) return name;
	const target = channelTarget(item);
	return target ? `${item.type} · ${target}` : item.type;
}
