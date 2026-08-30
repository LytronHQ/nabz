// How an alert channel reads in lists and escalation policies (#144).
//
// Targets (webhook URLs, API keys) are secrets — never render them in full, since
// screenshots leak them. `channelTarget` returns just enough to keep a channel
// identifiable; the full value lives in the Edit form. `channelDisplayName` prefers
// the channel's optional human Name, falling back to "provider · target".

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
export function channelTarget(item: any): string {
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
		default:
			return '';
	}
}

/**
 * How a channel is labelled where it's referenced (e.g. escalation-policy levels):
 * its Name when set, otherwise "provider · target".
 */
export function channelDisplayName(item: any): string {
	const name = (item.name ?? '').trim();
	if (name) return name;
	const target = channelTarget(item);
	return target ? `${item.type} · ${target}` : item.type;
}
