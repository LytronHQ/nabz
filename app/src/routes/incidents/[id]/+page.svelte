<script lang="ts">
	import { resolve } from '$app/paths';

	import { invalidateAll } from '$app/navigation';
	import { usePoll } from '$lib/utils/use-poll';
	import { Meta, Pill } from '$lib/components/common';
	import { formatRelativeTime, formatDuration, durationSeconds } from '$lib/utils/format-utils';

	let { data } = $props();

	let incident = $derived(data.incident);
	let monitor = $derived(data.monitor);
	let ongoing = $derived(!incident.resolved_at);

	// `now` ticks so an ongoing incident's Length counts up live.
	let now = $state(Date.now());
	let lengthSecs = $derived(durationSeconds(incident.started_at, incident.resolved_at, now));

	usePoll(() => (now = Date.now()), 1000);
	usePoll(() => invalidateAll(), 15000); // pick up resolution

	function startedAbsolute(s: string): string {
		const d = new Date(s);
		return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
	}

	// newest-first timeline
	let events = $derived([...(data.events ?? [])].reverse());

	const TYPE_LABEL: Record<string, string> = {
		opened: 'Opened',
		zone_down: 'Down',
		notified: 'Notified',
		resolved: 'Resolved',
		comment: 'Comment',
		acknowledged: 'Ack',
		escalated: 'Escalated'
	};

	let acknowledged = $derived(!!incident.acknowledged_at);

	let acting = $state(false);
	let actError = $state('');
	async function doAction(action: 'acknowledge' | 'escalate') {
		acting = true;
		actError = '';
		try {
			const res = await fetch(`/api/incidents/${incident.id}/action`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ action })
			});
			if (res.ok) {
				await invalidateAll();
			} else {
				const e = await res.json().catch(() => ({}));
				actError = e.error ?? 'Action failed';
			}
		} catch {
			actError = 'Action failed';
		}
		acting = false;
	}

	let comment = $state('');
	let posting = $state(false);
	let postError = $state('');
	async function postComment() {
		const msg = comment.trim();
		if (!msg) return;
		posting = true;
		postError = '';
		try {
			const res = await fetch(`/api/incidents/${incident.id}/events`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ message: msg })
			});
			if (res.ok) {
				comment = '';
				await invalidateAll();
			} else {
				const e = await res.json().catch(() => ({}));
				postError = e.error ?? 'Failed to post';
			}
		} catch {
			postError = 'Failed to post';
		}
		posting = false;
	}
</script>

<Meta title="Incident · {monitor.name}" />

<div class="crumb"><a href={resolve('/incidents')}>← Incidents</a></div>

<div class="detail-head">
	<h1>{monitor.name}</h1>
	{#if ongoing}
		<Pill tone="down" live label="Ongoing" />
	{:else}
		<Pill tone="up" label="Resolved" />
	{/if}
	{#if acknowledged}
		<Pill tone="acknowledged" label="Acknowledged" />
	{/if}
	<div class="toolbar" style="margin-left:auto">
		{#if ongoing && !acknowledged}
			<button
				type="button"
				class="btn btn-primary"
				onclick={() => doAction('acknowledge')}
				disabled={acting}
			>
				<svg
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="1.9"
					stroke-linecap="round"
					stroke-linejoin="round"><path d="M20 6L9 17l-5-5" /></svg
				>
				Acknowledge
			</button>
		{/if}
		{#if ongoing}
			<button
				type="button"
				class="btn btn-ghost"
				onclick={() => doAction('escalate')}
				disabled={acting}
			>
				<svg
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="1.8"
					stroke-linecap="round"
					stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7" /></svg
				>
				Escalate
			</button>
		{/if}
		<a class="btn btn-ghost" href={resolve('/monitors/[id]', { id: monitor.id })}>
			<svg
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="1.8"
				stroke-linecap="round"
				stroke-linejoin="round"><path d="M3 12h3l2-6 4 12 2.5-7 1.5 3H21" /></svg
			>
			View monitor
		</a>
	</div>
</div>
{#if actError}<div class="down-txt" style="font-size:12.5px;margin-top:6px">{actError}</div>{/if}
<div class="mono" style="color:var(--ink-3);font-size:12.5px">
	Incident · started {formatRelativeTime(incident.started_at)}{#if !ongoing}
		· resolved {formatRelativeTime(incident.resolved_at)}{/if}
</div>
{#if acknowledged}
	<div class="mono" style="color:var(--ink-3);font-size:12.5px">
		Acknowledged by {incident.acknowledged_by || 'a user'} · {formatRelativeTime(
			incident.acknowledged_at
		)}
	</div>
{/if}

<!-- stat tiles -->
<div class="grid grid-cols-2 lg:grid-cols-3 gap-3.5">
	<div class="card stat">
		<div class="label">Cause</div>
		<div class="value" style="font-size:22px">{incident.cause || '—'}</div>
	</div>
	<div class="card stat">
		<div class="label">Started at</div>
		<div class="value" style="font-size:22px">{formatRelativeTime(incident.started_at)}</div>
		<div class="delta mut">{startedAbsolute(incident.started_at)}</div>
	</div>
	<div class="card stat">
		<div class="label">Length</div>
		<div class="value {ongoing ? 'down-txt' : ''}" style="font-size:22px">
			{formatDuration(lengthSecs)}
		</div>
		<div class="delta {ongoing ? 'down-txt' : 'mut'}">{ongoing ? 'ongoing' : 'resolved'}</div>
	</div>
</div>

<!-- monitor metadata -->
<div class="card">
	<div class="card__h">
		<h3>Monitor</h3>
		<span class="hint">what was checked</span>
	</div>
	<div class="meta-grid">
		<div>
			<span class="k">Monitor</span><a href={resolve('/monitors/[id]', { id: monitor.id })}
				>{monitor.name}</a
			>
		</div>
		<div><span class="k">Type</span><span>{monitor.type}</span></div>
		<div>
			<span class="k">Checked URL</span><span class="mono" style="word-break:break-all"
				>{monitor.target}</span
			>
		</div>
		<div><span class="k">Interval</span><span>every {monitor.interval}s</span></div>
	</div>
</div>

<!-- timeline -->
<div class="card">
	<div class="card__h">
		<h3>Timeline</h3>
		<span class="hint">newest first</span>
	</div>
	<div class="tl">
		<form
			class="tl-compose"
			onsubmit={(e) => {
				e.preventDefault();
				postComment();
			}}
		>
			<textarea bind:value={comment} rows="2" placeholder="Leave a comment or post-mortem note…"
			></textarea>
			<div class="tl-compose__foot">
				{#if postError}<span class="down-txt" style="font-size:12.5px">{postError}</span>{/if}
				<button type="submit" class="btn btn-primary" disabled={posting || !comment.trim()}>
					{posting ? 'Posting…' : 'Post'}
				</button>
			</div>
		</form>

		<ul class="tl-feed">
			{#each events as ev (ev.id)}
				<li class="tl-item {ev.type}">
					<span class="tl-dot"></span>
					<div class="tl-body">
						<div class="tl-msg">
							<span class="tl-tag">{TYPE_LABEL[ev.type] ?? ev.type}</span>
							{ev.message}
							{#if ev.zone}<span class="zone-tag">{ev.zone}</span>{/if}
						</div>
						<div class="tl-meta">
							{#if ev.author}{ev.author} ·
							{/if}{formatRelativeTime(ev.created)}
						</div>
					</div>
				</li>
			{/each}
			{#if events.length === 0}
				<li class="tl-empty mut">No events yet.</li>
			{/if}
		</ul>
	</div>
</div>

<style>
	.meta-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
		gap: 16px 20px;
		padding: 16px;
	}
	.meta-grid > div {
		display: flex;
		flex-direction: column;
		gap: 3px;
		font-size: 13.5px;
		color: var(--ink);
	}
	.meta-grid .k {
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--ink-3);
	}
	.meta-grid a {
		color: var(--accent-strong);
		text-decoration: none;
	}
	.meta-grid a:hover {
		text-decoration: underline;
	}

	.tl {
		padding: 14px 16px;
	}
	.tl-compose {
		display: flex;
		flex-direction: column;
		gap: 8px;
		margin-bottom: 18px;
	}
	.tl-compose textarea {
		width: 100%;
		resize: vertical;
		font-family: inherit;
		font-size: 13.5px;
		color: var(--ink);
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: var(--radius-btn);
		padding: 9px 11px;
	}
	.tl-compose textarea:focus {
		outline: none;
		border-color: var(--accent);
	}
	.tl-compose__foot {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 12px;
	}
	.tl-feed {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
	}
	.tl-item {
		position: relative;
		display: flex;
		gap: 12px;
		padding: 0 0 16px 4px;
	}
	/* connector line between dots */
	.tl-item::before {
		content: '';
		position: absolute;
		left: 8px;
		top: 14px;
		bottom: -2px;
		width: 2px;
		background: var(--border);
	}
	.tl-item:last-child::before {
		display: none;
	}
	.tl-dot {
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
	.tl-item.opened .tl-dot,
	.tl-item.zone_down .tl-dot {
		background: var(--down);
	}
	.tl-item.resolved .tl-dot {
		background: var(--up);
	}
	.tl-item.notified .tl-dot {
		background: var(--accent);
	}
	.tl-item.acknowledged .tl-dot {
		background: var(--accent-strong);
	}
	.tl-item.escalated .tl-dot {
		background: var(--pending);
	}
	.tl-body {
		flex: 1;
		min-width: 0;
	}
	.tl-msg {
		font-size: 13.5px;
		color: var(--ink);
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}
	.tl-tag {
		font-family: inherit;
		font-size: 10.5px;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--ink-3);
		border: 1px solid var(--border);
		border-radius: var(--radius-btn);
		padding: 1px 6px;
	}
	.tl-meta {
		font-size: 12px;
		color: var(--ink-3);
		margin-top: 3px;
	}
	.tl-empty {
		padding: 8px 0;
		font-size: 13px;
	}
</style>
