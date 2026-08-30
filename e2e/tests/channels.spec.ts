import { test, expect, type APIRequestContext } from '@playwright/test';

// Real channel-delivery journeys (#126): create a real alert channel, drive a
// monitor DOWN through the real evaluator, and assert the alert actually went out.
//
// - Webhook is asserted end-to-end offline: the evaluator posts to a receiver on
//   the fixture server, and the test reads the exact payload back.
// - Telegram / Slack / Discord hit the REAL providers (a test bot / incoming
//   webhooks) and assert nabz's delivery result (channel_events outcome =
//   "delivered"), which catches "well-formed request the provider rejected" — the
//   class of bug the raw-status logging masked (#92). Each SKIPS with a clear
//   message when its credential isn't set, so the suite degrades gracefully.
//
// Isolation: each test gives its monitor an escalation policy that notifies ONLY
// its own channel, so no test spams another channel (or a real inbox).

const PB = process.env.E2E_PB || 'http://127.0.0.1:8390';
const FIXTURE_HOST = process.env.E2E_FIXTURE || 'http://127.0.0.1:8788'; // host → receiver
const FIXTURE_NET = 'http://fixture:8080'; // in-stack: monitor target + receiver
const USER_EMAIL = process.env.E2E_USER_EMAIL || 'user@e2e.local';
const USER_PASS = process.env.E2E_USER_PASSWORD || 'e2e-user-pass';

async function auth(api: APIRequestContext) {
	const res = await api.post(`${PB}/api/collections/users/auth-with-password`, {
		data: { identity: USER_EMAIL, password: USER_PASS }
	});
	expect(res.ok(), `user auth: ${res.status()}`).toBeTruthy();
	const b = await res.json();
	return { token: b.token as string, userId: b.record.id as string };
}

async function create(api: APIRequestContext, token: string, coll: string, data: unknown) {
	const res = await api.post(`${PB}/api/collections/${coll}/records`, {
		headers: { Authorization: token },
		data
	});
	expect(res.ok(), `create ${coll}: ${res.status()} ${await res.text()}`).toBeTruthy();
	return (await res.json()) as { id: string };
}

type ChannelSpec = { type: string; config: Record<string, string>; label: string };

// Create the channel + a policy that notifies only it + a DOWN monitor bound to
// that policy. Returns the ids and a cleanup that removes all three.
async function wireDownAlert(api: APIRequestContext, token: string, userId: string, spec: ChannelSpec) {
	const ch = await create(api, token, 'alert_channels', {
		user: userId,
		type: spec.type,
		name: spec.label,
		config: spec.config,
		enabled: true
	});
	const pol = await create(api, token, 'escalation_policies', {
		user: userId,
		name: spec.label,
		steps: [{ after_minutes: 0, channels: [ch.id] }]
	});
	const mon = await create(api, token, 'monitors', {
		user: userId,
		name: spec.label,
		type: 'website',
		target: `${FIXTURE_NET}/status/500`,
		interval: 30,
		enabled: true,
		status: 'pending',
		escalation_policy: pol.id
	});
	const del = (coll: string, id: string) =>
		api.delete(`${PB}/api/collections/${coll}/records/${id}`, { headers: { Authorization: token } });
	return {
		channelId: ch.id,
		cleanup: async () => {
			await del('monitors', mon.id).catch(() => {});
			await del('escalation_policies', pol.id).catch(() => {});
			await del('alert_channels', ch.id).catch(() => {});
		}
	};
}

// nabz records a per-channel delivery result in channel_events; wait for a
// "delivered" outcome on this channel (the provider accepted the alert).
async function expectDelivered(api: APIRequestContext, token: string, channelId: string) {
	const filter = encodeURIComponent(`channel='${channelId}'`);
	await expect
		.poll(
			async () => {
				const r = await api.get(
					`${PB}/api/collections/channel_events/records?filter=${filter}&sort=-created`,
					{ headers: { Authorization: token } }
				);
				const items = ((await r.json()).items ?? []) as { outcome: string }[];
				return items.map((i) => i.outcome);
			},
			{ timeout: 100_000, intervals: [3000] }
		)
		.toContain('delivered');
}

test('webhook channel: the incident payload actually reaches the receiver', async ({ request }) => {
	test.setTimeout(180_000);
	const { token, userId } = await auth(request);
	const hookId = `wh-${Date.now()}`;
	const { channelId, cleanup } = await wireDownAlert(request, token, userId, {
		type: 'webhook',
		label: 'e2e webhook',
		config: { url: `${FIXTURE_NET}/hook/${hookId}` }
	});
	try {
		// The receiver got nabz's real POST — assert the payload it delivered.
		await expect
			.poll(
				async () => {
					const r = await request.get(`${FIXTURE_HOST}/hook/${hookId}`);
					return r.ok() ? await r.text() : '';
				},
				{ timeout: 100_000, intervals: [3000] }
			)
			.toContain('incident.opened');

		const body = await (await request.get(`${FIXTURE_HOST}/hook/${hookId}`)).json();
		expect(body.event).toBe('incident.opened');
		expect(body.monitor).toBe('e2e webhook');

		await expectDelivered(request, token, channelId);
	} finally {
		await cleanup();
	}
});

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;
test('telegram channel: real delivery to the test bot/chat', async ({ request }) => {
	test.skip(!TG_TOKEN || !TG_CHAT, 'set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID');
	test.setTimeout(180_000);
	const { token, userId } = await auth(request);
	const { channelId, cleanup } = await wireDownAlert(request, token, userId, {
		type: 'telegram',
		label: 'e2e telegram',
		config: { botToken: TG_TOKEN!, chatId: TG_CHAT! }
	});
	try {
		await expectDelivered(request, token, channelId);
	} finally {
		await cleanup();
	}
});

const SLACK_URL = process.env.SLACK_WEBHOOK_URL;
test('slack channel: real delivery to the incoming webhook', async ({ request }) => {
	test.skip(!SLACK_URL, 'set SLACK_WEBHOOK_URL');
	test.setTimeout(180_000);
	const { token, userId } = await auth(request);
	const { channelId, cleanup } = await wireDownAlert(request, token, userId, {
		type: 'slack',
		label: 'e2e slack',
		config: { url: SLACK_URL! }
	});
	try {
		await expectDelivered(request, token, channelId);
	} finally {
		await cleanup();
	}
});

const DISCORD_URL = process.env.DISCORD_WEBHOOK_URL;
test('discord channel: real delivery to the incoming webhook', async ({ request }) => {
	test.skip(!DISCORD_URL, 'set DISCORD_WEBHOOK_URL');
	test.setTimeout(180_000);
	const { token, userId } = await auth(request);
	const { channelId, cleanup } = await wireDownAlert(request, token, userId, {
		type: 'discord',
		label: 'e2e discord',
		config: { url: DISCORD_URL! }
	});
	try {
		await expectDelivered(request, token, channelId);
	} finally {
		await cleanup();
	}
});

const PAGERDUTY_KEY = process.env.PAGERDUTY_ROUTING_KEY;
test('pagerduty channel: real delivery via the Events API v2', async ({ request }) => {
	test.skip(!PAGERDUTY_KEY, 'set PAGERDUTY_ROUTING_KEY');
	test.setTimeout(180_000);
	const { token, userId } = await auth(request);
	// NB: nabz triggers a real incident on the PagerDuty service (no resolve/dedup
	// key yet), so point this at a throwaway service.
	const { channelId, cleanup } = await wireDownAlert(request, token, userId, {
		type: 'pagerduty',
		label: 'e2e pagerduty',
		config: { routingKey: PAGERDUTY_KEY! }
	});
	try {
		await expectDelivered(request, token, channelId);
	} finally {
		await cleanup();
	}
});
