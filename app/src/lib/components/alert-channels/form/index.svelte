<script lang="ts">
	import {
		AlertChannelTypes,
		type AlertChannelItem,
		type AlertChannelNewItem,
		type AlertChannelType,
		type ChannelSettings
	} from '#lib/models/alert-channel.js';
	import { Select, Toggle } from '#lib/components/common/index.js';
	import { channelTarget } from '#lib/utils/channel-display.js';
	import { deviceName, preparePush, subscribe, type PushState } from '#lib/utils/push-subscribe.js';

	interface Props {
		/** Undefined while the page's modal is closed: the page only sets its item
		 *  when the modal opens, and the Modal renders this form only while open. */
		data: AlertChannelNewItem | AlertChannelItem | undefined;
		/** Per-field validation messages, keyed by field name (e.g. { url }, { botToken }). */
		errors?: Record<string, string>;
	}

	let { data = $bindable(), errors = {} }: Props = $props();
	// The same object as `data` (edits through it reach the page's $state), typed
	// as set: this form is only ever rendered once the page has an item.
	let item = $derived(data as AlertChannelNewItem | AlertChannelItem);

	const TYPE_NAMES: Partial<Record<AlertChannelType, string>> = {
		pagerduty: 'PagerDuty',
		push: 'Push notification'
	};
	const types: { value: AlertChannelType; name: string }[] = AlertChannelTypes.map((t) => ({
		name: TYPE_NAMES[t] ?? t.charAt(0).toUpperCase() + t.slice(1),
		value: t
	}));

	// `multiline` fields render as an auto-growing textarea so long values (webhook
	// URLs especially) are visible in full rather than truncated in a one-line input.
	type FieldDef = {
		key: keyof ChannelSettings;
		label: string;
		placeholder: string;
		multiline?: boolean;
	};

	// Each type renders only its own settings; Telegram takes two fields.
	const fieldsByType: Record<string, FieldDef[]> = {
		email: [{ key: 'email', label: 'Email address', placeholder: 'you@example.com' }],
		webhook: [
			{
				key: 'url',
				label: 'Webhook URL',
				placeholder: 'https://hooks.example.com/…',
				multiline: true
			}
		],
		slack: [
			{
				key: 'url',
				label: 'Slack incoming webhook URL',
				placeholder: 'https://hooks.slack.com/services/…',
				multiline: true
			}
		],
		discord: [
			{
				key: 'url',
				label: 'Discord webhook URL',
				placeholder: 'https://discord.com/api/webhooks/…',
				multiline: true
			}
		],
		telegram: [
			{ key: 'botToken', label: 'Bot token', placeholder: '123456:ABC-DEF1234ghIkl…' },
			{ key: 'chatId', label: 'Chat ID', placeholder: '-1001234567890 or @channelusername' }
		],
		pagerduty: [
			{
				key: 'routingKey',
				label: 'Integration routing key',
				placeholder: '32-character Events API v2 routing key'
			}
		]
	};

	let fields = $derived(fieldsByType[item.type] ?? []);

	// Grow a textarea to fit its content so the whole target is visible at a glance.
	function autogrow(node: HTMLTextAreaElement) {
		const resize = () => {
			node.style.height = 'auto';
			node.style.height = `${node.scrollHeight}px`;
		};
		resize();
		node.addEventListener('input', resize);
		return { destroy: () => node.removeEventListener('input', resize) };
	}

	// Per-type "how to get this" help (#176) — a collapsible with the key steps and a
	// docs link, for each type whose credential isn't obvious. Content is static and
	// author-controlled (safe for {@html}); email + generic webhook are
	// self-explanatory, so they have no entry.
	type Help = { summary: string; steps: string[]; link?: { href: string; label: string } };
	const helpByType: Record<string, Help> = {
		slack: {
			summary: 'How do I get a Slack webhook URL?',
			steps: [
				'Create (or open) a Slack app at <b>api.slack.com/apps</b>.',
				'Enable <b>Incoming Webhooks</b>, then <b>Add New Webhook to Workspace</b> and pick a channel.',
				'Copy the URL — it looks like <code>https://hooks.slack.com/services/…</code>.'
			],
			link: {
				href: 'https://api.slack.com/messaging/webhooks',
				label: 'Slack incoming webhooks guide'
			}
		},
		discord: {
			summary: 'How do I get a Discord webhook URL?',
			steps: [
				'In your server: <b>Server Settings → Integrations → Webhooks</b>.',
				'<b>New Webhook</b>, choose a channel, then <b>Copy Webhook URL</b>.',
				'It looks like <code>https://discord.com/api/webhooks/…</code>.'
			],
			link: {
				href: 'https://support.discord.com/hc/en-us/articles/228383668',
				label: 'Discord webhooks guide'
			}
		},
		telegram: {
			summary: 'How do I get my bot token and Chat ID?',
			steps: [
				'Create a bot with <b>@BotFather</b> (<code>/newbot</code>) — it gives you the <b>bot token</b>.',
				'Message <b>@userinfobot</b> to get your numeric <b>Id</b>; that’s your Chat ID.',
				'In the chat with <b>your</b> bot, send <code>/start</code> (or any message) — a bot can’t message you until you message it — then click <b>Detect</b>. For a public channel use <code>@channelname</code>; for a group, add the bot and use its <code>-100…</code> id.'
			],
			link: {
				href: 'https://core.telegram.org/bots#how-do-i-create-a-bot',
				label: 'Telegram bots intro'
			}
		},
		pagerduty: {
			summary: 'Where is my routing key?',
			steps: [
				'Open the PagerDuty service → <b>Integrations</b> → <b>Add integration</b>.',
				'Choose <b>Events API v2</b>.',
				'Copy the <b>Integration/Routing Key</b> (32 characters).'
			],
			link: {
				href: 'https://support.pagerduty.com/docs/services-and-integrations',
				label: 'PagerDuty integrations'
			}
		}
	};
	let help = $derived(helpByType[item.type]);

	// One-click Telegram Chat ID detection (#124): with a bot token entered, ask our
	// server to read the bot's recent updates and fill in the numeric Chat ID.
	let detecting = $state(false);
	let detectMsg = $state('');
	let detectOk = $state(false);
	async function detectChatId() {
		detectMsg = '';
		detecting = true;
		try {
			const res = await fetch('/api/alert-channels/detect-telegram-chat', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ botToken: (item.botToken ?? '').trim() })
			});
			const body = await res.json().catch(() => ({}));
			if (res.ok && body.chatId) {
				item.chatId = body.chatId;
				detectOk = true;
				detectMsg = body.name ? `Found ${body.name}` : 'Chat ID detected';
			} else {
				detectOk = false;
				detectMsg = body.error || 'Could not detect the Chat ID';
			}
		} catch {
			detectOk = false;
			detectMsg = 'Could not detect — try again';
		}
		detecting = false;
	}

	// Push (#602): the slow part (key + service worker) is prepared as soon as the
	// type is picked, so the tap can call subscribe() with nothing to wait for.
	let pushState = $state<PushState | null>(null);
	let pushBusy = $state(false);
	let pushMsg = $state('');
	let pushOk = $state(false);
	$effect(() => {
		if (item.type !== 'push' || pushState) return;
		preparePush()
			.then((s) => (pushState = s))
			.catch(() => (pushState = { kind: 'unsupported' }));
	});
	let subscribedTo = $derived(item.endpoint ? channelTarget(item) : '');

	function turnOnPush() {
		if (pushState?.kind !== 'ready') return;
		pushBusy = true;
		pushMsg = '';
		// No await before this call: it must run inside the tap (see push-subscribe.ts).
		subscribe(pushState)
			.then((keys) => {
				item.endpoint = keys.endpoint;
				item.p256dh = keys.p256dh;
				item.auth = keys.auth;
				if (!item.name.trim()) item.name = deviceName();
				pushOk = true;
				pushMsg = 'This device is ready. Save to start getting alerts here.';
			})
			.catch((err: unknown) => {
				pushOk = false;
				pushMsg =
					typeof Notification !== 'undefined' && Notification.permission === 'denied'
						? 'Notifications are blocked for nabz. Allow them in this browser’s site settings, then try again.'
						: `Could not turn on notifications: ${err instanceof Error ? err.message : String(err)}`;
			})
			.finally(() => (pushBusy = false));
	}
</script>

<div class="grid grid-cols-12 gap-4">
	<label class="col-span-12 block">
		<span class="form-lbl">Name <span class="opt">(optional)</span></span>
		<input
			class="form-input mt-1 block w-full"
			bind:value={item.name}
			placeholder="e.g. On-call Slack"
		/>
		<span class="hint-txt">Shown in escalation policies. Falls back to the target when empty.</span>
	</label>

	<div class="col-span-12 sm:col-span-4">
		<span class="form-lbl">Type</span>
		<Select class="mt-1" label="Type" items={types} bind:value={item.type} />
	</div>

	<div class="col-span-12 sm:col-span-8 grid gap-4">
		{#each fields as f (f.key)}
			<label class="block relative">
				<span class="form-lbl">{f.label}</span>
				{#if f.multiline}
					<textarea
						class="form-input mt-1 block w-full tgt-area"
						rows="1"
						use:autogrow
						bind:value={item[f.key]}
						placeholder={f.placeholder}></textarea>
				{:else if f.key === 'chatId'}
					<div class="chatid-row">
						<input class="form-input" bind:value={item.chatId} placeholder={f.placeholder} />
						<button
							type="button"
							class="btn btn-ghost detect-btn"
							onclick={detectChatId}
							disabled={!(item.botToken ?? '').trim() || detecting}
							title={!(item.botToken ?? '').trim()
								? 'Enter the bot token first'
								: 'Read the Chat ID from your bot’s recent messages'}
						>
							{detecting ? 'Detecting…' : 'Detect'}
						</button>
					</div>
					{#if detectMsg}
						<span class="detect-msg" class:ok={detectOk}>{detectMsg}</span>
					{:else}
						<span class="detect-hint"
							>Message your bot in Telegram first (e.g. send <code>/start</code>) — Detect reads its
							recent chats.</span
						>
					{/if}
				{:else}
					<input
						class="form-input mt-1 block w-full"
						bind:value={item[f.key]}
						placeholder={f.placeholder}
					/>
				{/if}
				{#if errors[f.key]}<span class="field-err">{errors[f.key]}</span>{/if}
			</label>
		{/each}

		{#if item.type === 'push'}
			<div class="push-box">
				<span class="form-lbl">This device</span>
				{#if subscribedTo}
					<span class="push-current" data-testid="push-current">Subscribed: {subscribedTo}</span>
				{/if}
				{#if pushState === null}
					<span class="push-note">Checking this browser…</span>
				{:else if pushState.kind === 'ready'}
					{#if !pushOk}
						<button
							type="button"
							class="btn btn-primary push-btn"
							onclick={turnOnPush}
							disabled={pushBusy}
						>
							{pushBusy
								? 'Waiting for permission…'
								: subscribedTo
									? 'Use this device instead'
									: 'Turn on notifications on this device'}
						</button>
					{/if}
					{#if pushMsg}
						<span class="detect-msg" class:ok={pushOk}>{pushMsg}</span>
					{:else}
						<span class="push-note"
							>Alerts arrive as notifications on the device you do this on. Add one channel per
							device.</span
						>
					{/if}
				{:else if pushState.kind === 'ios-home-screen'}
					<span class="push-note"
						>On iPhone and iPad, push alerts work only from the installed app: in Safari tap
						<b>Share → Add to Home Screen</b>, open nabz from the Home Screen, and add this channel
						there.</span
					>
				{:else if pushState.kind === 'blocked'}
					<span class="push-note"
						>Notifications are blocked for nabz in this browser. Allow them in the site settings,
						then reopen this form.</span
					>
				{:else if pushState.kind === 'not-configured'}
					<span class="push-note">Push alerts are not set up on this nabz server yet.</span>
				{:else if pushState.kind === 'no-worker'}
					<span class="push-note"
						>nabz’s background worker is not running in this browser, so it cannot receive
						notifications. Reload the page and try again; a private window may not allow it.</span
					>
				{:else}
					<span class="push-note"
						>This browser cannot receive push notifications. Try Chrome, Edge, Firefox or Safari.</span
					>
				{/if}
				{#if errors.endpoint}<span class="field-err">{errors.endpoint}</span>{/if}
			</div>
		{/if}

		{#if help}
			<details class="ch-help">
				<summary>{help.summary}</summary>
				<ol>
					{#each help.steps as step, i (i)}
						<!-- eslint-disable-next-line svelte/no-at-html-tags -- trusted: `step` is a literal from the static helpByType table above, never user input -->
						<li>{@html step}</li>
					{/each}
				</ol>
				{#if help.link}
					<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- an external docs URL from the channel help data, not an app route -->
					<a class="ch-help-link" href={help.link.href} target="_blank" rel="noopener noreferrer">
						{help.link.label} ↗
					</a>
				{/if}
			</details>
		{/if}
	</div>

	<div class="col-span-12">
		<Toggle bind:checked={item.enabled}>Enabled</Toggle>
	</div>
</div>

<style>
	.push-box {
		display: grid;
		gap: 6px;
		align-content: start;
	}
	.push-btn {
		justify-self: start;
		margin-top: 2px;
	}
	.push-note,
	.push-current {
		font-size: 12.5px;
		color: var(--ink-3);
		line-height: 1.5;
	}
	.push-current {
		color: var(--ink-2);
	}
	.opt {
		font-weight: 400;
		color: var(--ink-3);
	}
	.hint-txt {
		display: block;
		margin-top: 5px;
		font-size: 12px;
		color: var(--ink-3);
	}
	.tgt-area {
		resize: none;
		overflow: hidden;
		min-height: 40px;
		line-height: 1.5;
		word-break: break-all;
	}
	.chatid-row {
		display: flex;
		gap: 8px;
		margin-top: 4px;
	}
	.chatid-row .form-input {
		margin-top: 0;
		flex: 1 1 auto;
		min-width: 0;
	}
	.detect-btn {
		flex: 0 0 auto;
		white-space: nowrap;
	}
	.detect-msg {
		display: block;
		margin-top: 5px;
		font-size: 12px;
		color: var(--down);
	}
	.detect-msg.ok {
		color: var(--up);
	}
	.detect-hint {
		display: block;
		margin-top: 5px;
		font-size: 12px;
		color: var(--ink-3);
	}
	.detect-hint code {
		font-family: inherit;
		background: var(--surface-2);
		padding: 0 4px;
		border-radius: var(--radius-pill);
	}
	.ch-help {
		font-size: 13px;
		color: var(--ink-3);
	}
	.ch-help summary {
		cursor: pointer;
		user-select: none;
	}
	.ch-help summary:hover {
		color: var(--accent-strong);
	}
	.ch-help ol {
		margin: 8px 0 0;
		padding-left: 18px;
		display: grid;
		gap: 4px;
	}
	.ch-help :global(code) {
		font-family: inherit;
		background: var(--surface-2);
		padding: 0 4px;
		border-radius: var(--radius-pill);
	}
	.ch-help-link {
		display: inline-block;
		margin-top: 9px;
		font-size: 12.5px;
		color: var(--accent-strong);
		text-decoration: none;
	}
	.ch-help-link:hover {
		text-decoration: underline;
	}
</style>
