<script lang="ts">
	import { AlertChannelTypes } from '$lib/models/alert-channel';
	import { Select, Toggle } from '$lib/components/common';

	interface Props {
		data: any;
		/** Per-field validation messages, keyed by field name (e.g. { url }, { botToken }). */
		errors?: Record<string, string>;
	}

	let { data = $bindable(), errors = {} }: Props = $props();

	const types: { value: any; name: string }[] = AlertChannelTypes.map((t) => ({
		name: t.charAt(0).toUpperCase() + t.slice(1),
		value: t
	}));

	// `multiline` fields render as an auto-growing textarea so long values (webhook
	// URLs especially) are visible in full rather than truncated in a one-line input.
	type FieldDef = { key: string; label: string; placeholder: string; multiline?: boolean };

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

	let fields = $derived(fieldsByType[data.type] ?? []);

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
	let help = $derived(helpByType[data.type]);

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
				body: JSON.stringify({ botToken: (data.botToken ?? '').trim() })
			});
			const body = await res.json().catch(() => ({}));
			if (res.ok && body.chatId) {
				data.chatId = body.chatId;
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
</script>

<div class="grid grid-cols-12 gap-4">
	<label class="col-span-12 block">
		<span class="form-lbl">Name <span class="opt">(optional)</span></span>
		<input
			class="form-input mt-1 block w-full"
			bind:value={data.name}
			placeholder="e.g. On-call Slack"
		/>
		<span class="hint-txt">Shown in escalation policies. Falls back to the target when empty.</span>
	</label>

	<div class="col-span-12 sm:col-span-4">
		<span class="form-lbl">Type</span>
		<Select class="mt-1" items={types} bind:value={data.type} />
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
						bind:value={data[f.key]}
						placeholder={f.placeholder}></textarea>
				{:else if f.key === 'chatId'}
					<div class="chatid-row">
						<input class="form-input" bind:value={data.chatId} placeholder={f.placeholder} />
						<button
							type="button"
							class="btn btn-ghost detect-btn"
							onclick={detectChatId}
							disabled={!(data.botToken ?? '').trim() || detecting}
							title={!(data.botToken ?? '').trim()
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
						bind:value={data[f.key]}
						placeholder={f.placeholder}
					/>
				{/if}
				{#if errors[f.key]}<span class="field-err">{errors[f.key]}</span>{/if}
			</label>
		{/each}

		{#if help}
			<details class="ch-help">
				<summary>{help.summary}</summary>
				<ol>
					{#each help.steps as step, i (i)}
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
		<Toggle bind:checked={data.enabled}>Enabled</Toggle>
	</div>
</div>

<style>
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
