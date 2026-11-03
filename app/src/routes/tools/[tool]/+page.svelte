<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { Meta } from '#lib/components/common/index.js';
	import PublicHeader from '#lib/components/public/public-header.svelte';
	import { runMeasurement, probeLabel, type Measurement } from '#lib/tools/globalping.js';
	import {
		DNS_TYPES,
		LOCATIONS,
		TOOLS,
		parseInput,
		summarize,
		verdict,
		watchLink
	} from '#lib/tools/tools.js';

	let { data } = $props();
	let tool = $derived(data.tool);

	let input = $state('');
	let location = $state('world');
	let dnsType = $state('A');
	let error = $state('');
	let running = $state(false);
	let measurement = $state<Measurement | null>(null);
	let checked = $state('');
	let controller: AbortController | null = null;

	// A new tool (client navigation between tool pages) starts clean.
	$effect(() => {
		void tool.id;
		measurement = null;
		error = '';
		checked = '';
	});

	let rows = $derived(
		(measurement?.results ?? []).map((r) => ({
			where: probeLabel(r.probe) || 'Unknown place',
			...summarize(tool.id, r.result)
		}))
	);
	let overall = $derived(measurement ? verdict(tool.id, measurement.results) : null);
	let watch = $derived(checked ? watchLink(tool, checked, !!page.data.user) : null);
	let others = $derived(TOOLS.filter((t) => t.id !== tool.id));

	async function run(e: SubmitEvent) {
		e.preventDefault();
		error = '';
		const parsed = parseInput(tool.id, input, location, dnsType);
		if (!parsed.ok) {
			error = parsed.error;
			return;
		}
		controller?.abort();
		controller = new AbortController();
		running = true;
		measurement = null;
		checked = '';
		try {
			measurement = await runMeasurement(parsed.body, {
				signal: controller.signal,
				onUpdate: (m) => (measurement = m)
			});
			checked = parsed.target;
		} catch (err) {
			if ((err as Error).name !== 'AbortError') {
				error = (err as Error).message || 'The check failed. Try again.';
			}
		} finally {
			running = false;
		}
	}
</script>

<Meta title={tool.title} />

<div class="tk-page">
	<div class="tk">
		<PublicHeader />
		<a class="tk-back" href={resolve('/tools')}>← All tools</a>
		<h1>{tool.title}</h1>
		<p class="tk-lead">{tool.blurb}</p>

		<form class="tk-form" onsubmit={run}>
			<div class="field tk-target">
				<label for="tk-input">{tool.inputLabel}</label>
				<input
					id="tk-input"
					type="text"
					inputmode="url"
					autocomplete="off"
					spellcheck="false"
					placeholder={tool.placeholder}
					bind:value={input}
					required
				/>
			</div>
			{#if tool.id === 'dns'}
				<div class="field tk-opt">
					<label for="tk-dns">Record</label>
					<select id="tk-dns" class="form-input" bind:value={dnsType}>
						{#each DNS_TYPES as t (t)}<option value={t}>{t}</option>{/each}
					</select>
				</div>
			{/if}
			<div class="field tk-opt">
				<label for="tk-from">From</label>
				<select id="tk-from" class="form-input" bind:value={location}>
					{#each LOCATIONS as l (l.value)}<option value={l.value}>{l.label}</option>{/each}
				</select>
			</div>
			<button type="submit" class="btn btn-primary tk-run" disabled={running}>
				{running ? 'Checking…' : 'Check'}
			</button>
		</form>
		<p class="tk-public">
			Checks run on <a href="https://globalping.io" rel="noopener">Globalping</a>'s volunteer
			probes, and Globalping publishes every measurement. Do not check private addresses or put
			secrets in the URL.
		</p>

		{#if error}<p class="tk-error" role="alert">{error}</p>{/if}

		{#if measurement}
			<section class="card tk-results" aria-live="polite" aria-labelledby="tk-verdict">
				<div class="card__h">
					<h3 id="tk-verdict">{overall ?? 'Checking…'}</h3>
					<span class="hint">{rows.length} {rows.length === 1 ? 'probe' : 'probes'}</span>
				</div>
				<ul class="tk-rows">
					{#each rows as r, i (i)}
						<li class="tk-row">
							<span
								class="tk-dot {r.ok === null ? 'pend' : r.ok ? 'up' : 'down'}"
								aria-hidden="true"
							></span>
							<span class="tk-where">{r.where}</span>
							<span class="tk-line">{r.line}</span>
							{#if r.detail}<span class="tk-detail">{r.detail}</span>{/if}
						</li>
					{/each}
				</ul>
			</section>

			{#if watch}
				<div class="tk-watch">
					<p>
						A one-off check tells you about now. nabz checks it again every few minutes from several
						zones, and alerts you only when they agree it is down.
					</p>
					<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- built by watchLink from app paths -->
					<a class="btn btn-primary" href={watch.href}>{watch.label}</a>
				</div>
			{/if}
		{/if}

		<h2>Other tools</h2>
		<ul class="tk-others">
			{#each others as t (t.id)}
				<li><a href={resolve('/tools/[tool]', { tool: t.id })}>{t.name}</a></li>
			{/each}
		</ul>
	</div>
</div>

<style>
	.tk-page {
		min-height: 100vh;
		background: var(--ground);
	}
	.tk {
		max-width: 880px;
		margin: 0 auto;
		padding: 24px 16px 48px;
	}
	.tk-back {
		font-size: 13px;
		color: var(--ink-2);
	}
	h1 {
		margin: 10px 0 8px;
		font-size: 32px;
		color: var(--ink);
	}
	.tk-lead {
		margin: 0 0 22px;
		color: var(--ink-2);
		font-size: 16px;
		max-width: 62ch;
	}
	.tk-form {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: 12px;
	}
	.tk-form :global(.field) {
		margin-bottom: 0;
		min-width: 0;
	}
	.tk-target {
		flex: 1 1 280px;
	}
	.tk-form select {
		min-width: 140px;
		height: 42px;
	}
	.tk-run {
		height: 42px;
	}
	.tk-public {
		margin: 10px 0 0;
		font-size: 12.5px;
		color: var(--ink-3);
		max-width: 70ch;
	}
	.tk-public a,
	.tk-others a {
		color: var(--accent);
		text-decoration: underline;
		text-underline-offset: 2px;
	}
	.tk-error {
		margin: 16px 0 0;
		color: var(--down);
		font-size: 14px;
	}
	.tk-results {
		margin-top: 22px;
	}
	.tk-rows {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.tk-row {
		display: grid;
		grid-template-columns: 10px minmax(0, 1fr) auto;
		align-items: center;
		gap: 4px 12px;
		padding: 12px 16px;
		border-bottom: 1px solid var(--border);
		font-size: 14px;
	}
	.tk-row:last-child {
		border-bottom: 0;
	}
	.tk-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--pending);
	}
	.tk-dot.up {
		background: var(--up);
	}
	.tk-dot.down {
		background: var(--down);
	}
	.tk-where {
		color: var(--ink);
		overflow-wrap: anywhere;
	}
	.tk-line {
		color: var(--ink);
		font-variant-numeric: tabular-nums;
		text-align: end;
		overflow-wrap: anywhere;
	}
	.tk-detail {
		grid-column: 2 / -1;
		font-size: 12px;
		color: var(--ink-3);
		overflow-wrap: anywhere;
	}
	.tk-watch {
		margin-top: 18px;
		padding: 16px 18px;
		border: 1px solid var(--accent);
		border-radius: var(--radius-btn);
		background: var(--accent-wash);
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}
	.tk-watch p {
		margin: 0;
		max-width: 58ch;
		color: var(--ink);
		font-size: 14px;
	}
	h2 {
		margin: 40px 0 10px;
		font-size: 18px;
		color: var(--ink);
	}
	.tk-others {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-wrap: wrap;
		gap: 8px 18px;
		font-size: 14px;
	}
	@media (max-width: 560px) {
		h1 {
			font-size: 26px;
		}
		.tk-row {
			grid-template-columns: 10px minmax(0, 1fr);
		}
		.tk-line {
			grid-column: 2;
			text-align: start;
		}
		/* On the field, not the select: .field is a column, so a flex basis on the
		   select became its height (a 140 px tall box at 390 px). */
		.tk-opt,
		.tk-run {
			flex: 1 1 140px;
		}
		.tk-form select {
			width: 100%;
		}
	}
</style>
