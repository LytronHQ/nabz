<script lang="ts">
	import { resolve } from '$app/paths';
	import { invalidateAll, goto } from '$app/navigation';
	import { Meta, Pagination, Pill } from '$lib/components/common';
	import { PaginationData } from '$lib/models';
	import { formatRelativeTime } from '$lib/utils/format-utils';

	let { data } = $props();

	let channel = $derived(data.channel);
	let events = $derived(data.events ?? []);
	let pagination = $derived(new PaginationData(data.pagination as any));
	function onPage(detail: { page: number }) {
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- the path is resolve()d inside this template literal
		goto(`${resolve('/alerts/[id]', { id: channel.id })}?page=${detail.page}`, { noScroll: true });
	}

	// Targets are secrets — show host + short tail, not the full URL. Full value
	// lives in the Edit form on /alerts.
	function maskTarget(type: string, target: string): string {
		if (type === 'email' || !target) return target;
		try {
			const host = new URL(target).host;
			return `${host} · …${target.replace(/\/+$/, '').slice(-6)}`;
		} catch {
			return target;
		}
	}

	const KIND_LABEL: Record<string, string> = {
		test: 'Test',
		incident: 'Incident',
		recovery: 'Recovery'
	};

	let testing = $state(false);
	let testError = $state('');
	async function sendTest() {
		testing = true;
		testError = '';
		try {
			const res = await fetch('/api/test-alert', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ channel: channel.id })
			});
			if (!res.ok) {
				const e = await res.json().catch(() => ({}));
				testError = e.error ?? 'Test failed';
			}
		} catch {
			testError = 'Test failed';
		}
		testing = false;
		await invalidateAll(); // the new test delivery shows up in the log
	}
</script>

<Meta title="Channel · {channel.type}" />

<div class="crumb"><a href={resolve('/alerts')}>← Alert channels</a></div>

<div class="detail-head">
	<h1 style="text-transform:capitalize">{channel.type}</h1>
	{#if channel.enabled}
		<Pill tone="up" label="On" />
	{:else}
		<Pill tone="paused" label="Off" />
	{/if}
	<div class="toolbar" style="margin-left:auto">
		{#if channel.enabled}
			<button type="button" class="btn btn-primary" onclick={sendTest} disabled={testing}>
				<svg
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="1.8"
					stroke-linecap="round"
					stroke-linejoin="round"><path d="M22 2L11 13" /><path d="M22 2l-7 20-4-9-9-4z" /></svg
				>
				{testing ? 'Sending…' : 'Send test'}
			</button>
		{/if}
	</div>
</div>
<div class="mono" style="color:var(--ink-3);font-size:12.5px">
	{maskTarget(channel.type, channel.target)}
</div>
{#if testError}<div class="down-txt" style="font-size:12.5px;margin-top:6px">{testError}</div>{/if}

<div class="card" style="margin-top:16px">
	<div class="card__h">
		<h3>Delivery log</h3>
		<span class="hint">tests + incident &amp; recovery alerts · last 90 days</span>
	</div>
	<ul class="log">
		{#each events as ev (ev.id)}
			<li class="log-item {ev.outcome}">
				<span class="dot"></span>
				<div class="body">
					<div class="line">
						<span class="tag">{KIND_LABEL[ev.kind] ?? ev.kind}</span>
						<b class="outcome">{ev.outcome}</b>
						{#if ev.detail}<span class="detail">— {ev.detail}</span>{/if}
					</div>
					<div class="meta">{formatRelativeTime(ev.created)}</div>
				</div>
			</li>
		{/each}
		{#if events.length === 0}
			<li class="empty mut">No deliveries yet — send a test, or wait for an incident.</li>
		{/if}
	</ul>
</div>

{#if pagination.isVisible}
	<div style="margin-top:14px">
		<Pagination data={pagination} onupdate={onPage} />
	</div>
{/if}

<style>
	.log {
		list-style: none;
		margin: 0;
		padding: 14px 16px;
		display: flex;
		flex-direction: column;
	}
	.log-item {
		position: relative;
		display: flex;
		gap: 12px;
		padding: 0 0 16px 4px;
	}
	.log-item::before {
		content: '';
		position: absolute;
		left: 8px;
		top: 14px;
		bottom: -2px;
		width: 2px;
		background: var(--border);
	}
	.log-item:last-child::before {
		display: none;
	}
	.dot {
		position: relative;
		z-index: 1;
		flex: 0 0 10px;
		width: 10px;
		height: 10px;
		margin-top: 4px;
		border-radius: 50%;
		background: var(--ink-3);
		box-shadow: 0 0 0 3px var(--surface);
	}
	.log-item.delivered .dot {
		background: var(--up);
	}
	.log-item.skipped .dot {
		background: var(--pending);
	}
	.log-item.failed .dot {
		background: var(--down);
	}
	.body {
		flex: 1;
		min-width: 0;
	}
	.line {
		font-size: 13.5px;
		color: var(--ink);
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}
	.tag {
		font-family: inherit;
		font-size: 10.5px;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--ink-3);
		border: 1px solid var(--border);
		border-radius: var(--radius-btn);
		padding: 1px 6px;
	}
	.outcome {
		text-transform: capitalize;
	}
	.log-item.delivered .outcome {
		color: var(--up);
	}
	.log-item.skipped .outcome {
		color: var(--pending);
	}
	.log-item.failed .outcome {
		color: var(--down);
	}
	.detail {
		color: var(--ink-3);
		font-size: 12.5px;
	}
	.meta {
		font-size: 12px;
		color: var(--ink-3);
		margin-top: 3px;
	}
	.empty {
		padding: 6px 0;
		font-size: 13px;
	}
</style>
