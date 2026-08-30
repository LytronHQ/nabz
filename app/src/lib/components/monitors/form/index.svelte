<script lang="ts">
	import { MonitorNewItem, MonitorTypes, isSupportedMonitorType } from '$lib/models/monitor';
	import { Select, Toggle } from '$lib/components/common';

	type SelectOption = { value: any; name: string };
	import { TagInput } from '$lib/components/monitors/tag-input';

	interface Props {
		data: any;
		availableZones?: { zone: string; label?: string; group?: string; stale: boolean }[];
		availablePolicies?: { id: string; name: string }[];
		/** Per-field validation messages, keyed by field name (e.g. { name, target }). */
		errors?: Record<string, string>;
	}

	let {
		data = $bindable(),
		availableZones = [],
		availablePolicies = [],
		errors = {}
	}: Props = $props();

	const capitalize = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

	// Only offer types the worker can actually run. Unimplemented types are
	// listed as "coming soon" below rather than being selectable (issue #82).
	const types: SelectOption[] = MonitorTypes.filter(isSupportedMonitorType).map((t) => ({
		name: capitalize(t),
		value: t
	}));

	const comingSoonTypes = MonitorTypes.filter((t) => !isSupportedMonitorType(t)).map(capitalize);

	const bodyCheckModes: SelectOption[] = [
		{ name: 'No body check', value: '' },
		{ name: 'Body contains', value: 'contains' },
		{ name: 'Body does not contain', value: 'absent' }
	];

	const httpMethods: SelectOption[] = [
		{ name: 'GET', value: 'GET' },
		{ name: 'HEAD', value: 'HEAD' },
		{ name: 'POST', value: 'POST' }
	];

	const dnsRecordTypes: SelectOption[] = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS'].map((t) => ({
		name: t,
		value: t
	}));

	// Maintenance windows: <input type="datetime-local"> works in local wall-clock;
	// we store UTC ISO. Convert between the two.
	function isoToLocalInput(iso: string): string {
		if (!iso) return '';
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return '';
		return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
	}
	function localInputToIso(local: string): string {
		if (!local) return '';
		const d = new Date(local); // parsed as local time
		return Number.isNaN(d.getTime()) ? '' : d.toISOString();
	}
	function addWindow() {
		data.maintenanceWindows = [...(data.maintenanceWindows ?? []), { start: '', end: '' }];
	}
	function removeWindow(i: number) {
		data.maintenanceWindows = data.maintenanceWindows.filter((_: any, idx: number) => idx !== i);
	}
	function setWindow(i: number, key: 'start' | 'end', localVal: string) {
		data.maintenanceWindows[i] = {
			...data.maintenanceWindows[i],
			[key]: localInputToIso(localVal)
		};
		data.maintenanceWindows = data.maintenanceWindows;
	}

	// Advanced options are collapsed by default, but open automatically when the
	// monitor already has any of them set (so editing doesn't hide existing config).
	// Tags are edited as a comma-separated string; kept in sync with data.tags.
	let showAdvanced = $state(false);
	let showMaint = $state(false);
	let advKey: string | undefined = $state(undefined);
	$effect(() => {
		if (data?.id !== advKey) {
			advKey = data?.id;
			if (!Array.isArray(data.tags)) data.tags = [];
			showAdvanced =
				!!data?.latencyThresholdMs ||
				!!data?.keywordMode ||
				(!!data?.method && data.method !== 'GET') ||
				!!data?.expectedStatus ||
				!!(data?.headers ?? '').trim() ||
				data?.followRedirects === false ||
				!!data?.timeoutSecs ||
				(!!data?.dnsRecordType && data.dnsRecordType !== 'A') ||
				!!(data?.dnsExpectedValue ?? '').trim() ||
				!!(data?.dnsResolver ?? '').trim();
			showMaint = (data?.maintenanceWindows?.length ?? 0) > 0;
		}
	});

	let policyOptions = $derived([
		{ name: 'Notify all channels immediately', value: '' },
		...availablePolicies.map((p) => ({ name: p.name, value: p.id }))
	]);

	function toggleZone(zone: string, checked: boolean) {
		const set = new Set<string>(data.zones ?? []);
		if (checked) set.add(zone);
		else set.delete(zone);
		data.zones = [...set];
	}

	const targetLabels: Record<string, string> = {
		website: 'URL',
		port: 'Host:Port',
		ping: 'Host',
		heartbeat: 'Heartbeat ID',
		duplicati: 'Machine name',
		dns: 'Hostname'
	};

	const targetPlaceholders: Record<string, string> = {
		website: 'https://example.com',
		port: 'example.com:443',
		ping: 'example.com',
		heartbeat: 'my-heartbeat-id',
		duplicati: 'my-machine',
		dns: 'example.com'
	};

	// Same reason as MonitorFormPage's: `data` is rebuilt on a same-route navigation.
	let isNew = $derived(data instanceof MonitorNewItem);

	let targetLabel = $derived(targetLabels[data.type] ?? 'Target');
	let targetPlaceholder = $derived(targetPlaceholders[data.type] ?? '');
</script>

<div class="grid grid-cols-12 gap-4">
	<label class="col-span-12 block relative">
		<span class="form-lbl">Name</span>
		<input class="form-input mt-1 block w-full" bind:value={data.name} placeholder="My website" />
		{#if errors.name}<span class="field-err">{errors.name}</span>{/if}
	</label>

	<div class="col-span-12 block">
		<span class="form-lbl">Tags</span>
		<div class="mt-1"><TagInput bind:tags={data.tags} /></div>
	</div>

	<div class="col-span-12 sm:col-span-6 relative">
		<span class="form-lbl">Type</span>
		{#if isNew}
			<Select class="mt-1" items={types} bind:value={data.type} />
			{#if comingSoonTypes.length > 0}
				<p class="mt-1 text-xs form-hint" data-testid="coming-soon-note">
					{comingSoonTypes.join(', ')} monitors are coming soon.
				</p>
			{/if}
		{:else}
			<input
				class="form-input mt-1 block w-full bg-[var(--surface-2)]"
				value={data.type}
				readonly
			/>
		{/if}
		{#if errors.type}<span class="field-err">{errors.type}</span>{/if}
	</div>

	<label class="col-span-12 sm:col-span-6 block relative">
		<span class="form-lbl">Interval (seconds)</span>
		<input type="number" min="30" class="form-input mt-1 block w-full" bind:value={data.interval} />
		<span class="block mt-1 text-xs form-hint">Minimum 30 seconds.</span>
		{#if errors.interval}<span class="field-err">{errors.interval}</span>{/if}
	</label>

	{#if data.type === 'heartbeat'}
		<div class="col-span-12">
			<span class="form-lbl">Check-in URL</span>
			<p class="mt-1 text-sm form-hint">
				A unique check-in URL is generated when you save — have your cron job or scheduled task
				request it on each run. If nabz doesn't hear from it within the interval (plus a short grace
				period), it opens an incident; the next check-in resolves it. The URL appears on the
				monitor's page after saving.
			</p>
		</div>
	{:else}
		<label class="col-span-12 block relative">
			<span class="form-lbl">{targetLabel}</span>
			<input
				class="form-input mt-1 block w-full"
				bind:value={data.target}
				placeholder={targetPlaceholder}
			/>
			{#if errors.target}<span class="field-err">{errors.target}</span>{/if}
			{#if data.type === 'ping'}
				<span class="block mt-1 text-xs form-hint"
					>TCP reachability — connects on :443 by default, or specify <code>host:port</code>.</span
				>
			{/if}
		</label>
	{/if}

	<details class="col-span-12 adv" bind:open={showAdvanced}>
		<summary class="adv-summary">
			<svg
				class="adv-chevron"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2.2"
				stroke-linecap="round"
				stroke-linejoin="round"><path d="M9 18l6-6-6-6" /></svg
			>
			Advanced options
			<span class="adv-hint"
				>slow-response alert{#if data.type === 'website' || data.type === ''}
					· body check · method · headers{/if}{#if data.type === 'dns'}
					· record type · expected value · resolver{/if}</span
			>
		</summary>
		<div class="grid grid-cols-12 gap-4 adv-body">
			<label class="col-span-12 sm:col-span-6 block relative">
				<span class="form-lbl">Slow-response alert (ms)</span>
				<input
					type="number"
					min="1"
					class="form-input mt-1 block w-full"
					bind:value={data.latencyThresholdMs}
					placeholder="off"
				/>
				<p class="mt-1 text-xs form-hint">
					Alert when p95 response time exceeds this, separate from up/down (flap-damped).
				</p>
				{#if errors.latencyThresholdMs}<span class="field-err">{errors.latencyThresholdMs}</span
					>{/if}
			</label>

			{#if data.type === 'website' || data.type === ''}
				<div class="col-span-12 sm:col-span-6">
					<span class="form-lbl">Response body check</span>
					<Select class="mt-1" items={bodyCheckModes} bind:value={data.keywordMode} />
					<p class="mt-1 text-xs form-hint">
						Fail the check even on a 200 if the page doesn't match.
					</p>
				</div>
				{#if data.keywordMode === 'contains' || data.keywordMode === 'absent'}
					<label class="col-span-12 sm:col-span-6 block relative">
						<span class="form-lbl">Text to check for</span>
						<input
							class="form-input mt-1 block w-full"
							bind:value={data.keyword}
							placeholder="e.g. Welcome"
						/>
						{#if errors.keyword}<span class="field-err">{errors.keyword}</span>{/if}
					</label>
				{/if}

				<div class="col-span-12 sm:col-span-4">
					<span class="form-lbl">Method</span>
					<Select class="mt-1" items={httpMethods} bind:value={data.method} />
				</div>
				<label class="col-span-12 sm:col-span-4 block relative">
					<span class="form-lbl">Expected status</span>
					<input
						type="number"
						min="100"
						max="599"
						class="form-input mt-1 block w-full"
						bind:value={data.expectedStatus}
						placeholder="any 2xx/3xx"
					/>
					{#if errors.expectedStatus}<span class="field-err">{errors.expectedStatus}</span>{/if}
				</label>
				<label class="col-span-12 sm:col-span-4 block relative">
					<span class="form-lbl">Timeout (seconds)</span>
					<input
						type="number"
						min="1"
						max="120"
						class="form-input mt-1 block w-full"
						bind:value={data.timeoutSecs}
						placeholder="20"
					/>
					{#if errors.timeoutSecs}<span class="field-err">{errors.timeoutSecs}</span>{/if}
				</label>
				<label class="col-span-12 block">
					<span class="form-lbl">Custom headers</span>
					<textarea
						class="form-input mt-1 block w-full"
						rows="2"
						bind:value={data.headers}
						placeholder="X-Api-Key: secret"></textarea>
					<p class="mt-1 text-xs form-hint">One per line, as "Name: Value".</p>
				</label>
				<div class="col-span-12">
					<Toggle bind:checked={data.followRedirects}>Follow redirects</Toggle>
				</div>
			{/if}

			{#if data.type === 'dns'}
				<div class="col-span-12 sm:col-span-4">
					<span class="form-lbl">Record type</span>
					<Select class="mt-1" items={dnsRecordTypes} bind:value={data.dnsRecordType} />
				</div>
				<label class="col-span-12 sm:col-span-8 block relative">
					<span class="form-lbl">Expected value (optional)</span>
					<input
						class="form-input mt-1 block w-full"
						bind:value={data.dnsExpectedValue}
						placeholder="e.g. 93.184.216.34"
					/>
					<p class="mt-1 text-xs form-hint">Up only if a resolved record contains this.</p>
				</label>
				<label class="col-span-12 sm:col-span-6 block">
					<span class="form-lbl">Resolver (optional)</span>
					<input
						class="form-input mt-1 block w-full"
						bind:value={data.dnsResolver}
						placeholder="system default — e.g. 8.8.8.8"
					/>
					<p class="mt-1 text-xs form-hint">
						Query a specific DNS server instead of the system resolver.
					</p>
				</label>
			{/if}
		</div>
	</details>

	<details class="col-span-12 adv" bind:open={showMaint}>
		<summary class="adv-summary">
			<svg
				class="adv-chevron"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2.2"
				stroke-linecap="round"
				stroke-linejoin="round"><path d="M9 18l6-6-6-6" /></svg
			>
			Maintenance windows
			<span class="adv-hint">suppress alerts during planned work</span>
		</summary>
		<div class="adv-body mw">
			{#each data.maintenanceWindows ?? [] as w, i (i)}
				<div class="mw-row">
					<input
						type="datetime-local"
						class="form-input mw-input"
						value={isoToLocalInput(w.start)}
						oninput={(e) => setWindow(i, 'start', e.currentTarget.value)}
					/>
					<span class="mw-to">to</span>
					<input
						type="datetime-local"
						class="form-input mw-input"
						value={isoToLocalInput(w.end)}
						oninput={(e) => setWindow(i, 'end', e.currentTarget.value)}
					/>
					<button type="button" class="mw-remove" title="Remove" onclick={() => removeWindow(i)}
						>✕</button
					>
				</div>
			{/each}
			<button type="button" class="mw-add" onclick={addWindow}>+ Add window</button>
			<p class="mt-1 text-xs form-hint">
				Times are in your local timezone. Checks keep running; only alerts are paused.
			</p>
		</div>
	</details>

	<div class="col-span-12">
		<span class="form-lbl">Zones</span>
		{#if availableZones.length > 0}
			<div class="mt-1 flex flex-wrap gap-3">
				{#each availableZones as z (z.zone)}
					<!-- The badge sits OUTSIDE the label on purpose: inside, it becomes part
					     of the checkbox's accessible name ("us not reporting"), which is a
					     worse label for a screen reader than the zone on its own. -->
					<span class="inline-flex items-center gap-2">
						<label class="inline-flex items-center gap-2">
							<input
								type="checkbox"
								class="form-checkbox"
								checked={(data.zones ?? []).includes(z.zone)}
								onchange={(e) => toggleZone(z.zone, e.currentTarget.checked)}
							/>
							<span title={z.label && z.label !== z.zone ? z.zone : undefined}
								>{z.label || z.zone}</span
							>
						</label>
						{#if z.stale}
							<span class="zone-warn" title="No recent heartbeat from this zone">not reporting</span
							>
						{/if}
					</span>
				{/each}
			</div>
			<p class="mt-1 text-xs form-hint">
				Leave all unchecked to run in every zone. A zone marked <em>not reporting</em> has no live worker
				— assigning it will not add cross-zone confirmation until one is back.
			</p>
		{:else}
			<p class="mt-1 text-xs form-hint">Runs in all zones (no zones reporting yet).</p>
		{/if}
	</div>

	<div class="col-span-12 sm:col-span-6">
		<span class="form-lbl">Escalation policy</span>
		<Select class="mt-1" items={policyOptions} bind:value={data.escalationPolicy} />
		<p class="mt-1 text-xs form-hint">
			How to page when this monitor is down. Manage under Escalations.
		</p>
	</div>

	<div class="col-span-12">
		<Toggle bind:checked={data.enabled}>Enabled</Toggle>
	</div>
</div>

<style>
	.adv {
		border: 1px solid var(--border);
		border-radius: var(--radius-btn);
		background: var(--surface-2);
	}
	.adv-summary {
		cursor: pointer;
		list-style: none;
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 10px 12px;
		font-size: 14px;
		color: var(--ink-2);
		user-select: none;
	}
	.adv-summary::-webkit-details-marker {
		display: none;
	}
	.adv-chevron {
		width: 15px;
		height: 15px;
		color: var(--ink-3);
		transition: transform 0.15s ease;
		flex: 0 0 15px;
	}
	.adv[open] .adv-chevron {
		transform: rotate(90deg);
	}
	.adv-hint {
		color: var(--ink-3);
		font-size: 12px;
		margin-left: auto;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.adv-body {
		padding: 4px 12px 14px;
	}
	.mw-row {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 8px;
	}
	.mw-input {
		flex: 1 1 0;
		min-width: 0;
	}
	.mw-to {
		color: var(--ink-3);
		font-size: 13px;
		flex: 0 0 auto;
	}
	.mw-remove {
		flex: 0 0 auto;
		background: none;
		border: 0;
		cursor: pointer;
		color: var(--ink-3);
		font-size: 14px;
		padding: 4px;
	}
	.mw-remove:hover {
		color: var(--down);
	}
	.mw-add {
		background: none;
		border: 0;
		cursor: pointer;
		color: var(--accent-strong);
		font-size: 13px;
		padding: 4px 0;
	}
</style>
