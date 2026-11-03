<script lang="ts">
	// The status page fields (#679), shared by the new and edit forms. Plain named
	// inputs: both forms are SvelteKit form actions, so this posts as is.
	interface Props {
		values: { title: string; slug: string; description: string; monitors: string[] };
		monitors: { id: string; name: string }[];
		errors?: Record<string, string>;
		origin: string;
	}
	let { values, monitors, errors = {}, origin }: Props = $props();

	// svelte-ignore state_referenced_locally
	let slug = $state(values.slug);
	// svelte-ignore state_referenced_locally
	let slugTouched = $state(values.slug !== '');
	// svelte-ignore state_referenced_locally
	let title = $state(values.title);
	// Suggest an address from the title until the owner types one.
	const toSlug = (t: string) =>
		t
			.toLowerCase()
			.normalize('NFKD')
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 40);
	$effect(() => {
		if (!slugTouched) slug = toSlug(title);
	});
</script>

<div class="spf">
	<div class="field">
		<label for="sp-title">Title</label>
		<input id="sp-title" name="title" type="text" maxlength="80" required bind:value={title} />
		{#if errors.title}<span class="field-err field-err--flow">{errors.title}</span>{/if}
	</div>

	<div class="field">
		<label for="sp-slug">Address</label>
		<div class="spf-slug">
			<span class="spf-slug__prefix">/s/</span>
			<input
				id="sp-slug"
				name="slug"
				type="text"
				maxlength="40"
				required
				autocomplete="off"
				spellcheck="false"
				bind:value={slug}
				oninput={() => (slugTouched = true)}
			/>
		</div>
		{#if errors.slug}<span class="field-err field-err--flow">{errors.slug}</span>{:else}<span
				class="spf-hint">{origin}/s/{slug || 'your-name'}</span
			>{/if}
	</div>

	<div class="field">
		<label for="sp-desc">Description <span class="opt">(optional)</span></label>
		<textarea id="sp-desc" name="description" maxlength="500" rows="2"
			>{values.description}</textarea
		>
		{#if errors.description}<span class="field-err field-err--flow">{errors.description}</span>{/if}
	</div>

	<fieldset class="spf-mons">
		<legend>Monitors to show</legend>
		<p class="spf-note">
			Visitors see each monitor's name, whether it is up, its uptime and when incidents happened.
			Never its address or error details.
		</p>
		{#if monitors.length === 0}
			<p class="spf-note">You have no monitors yet. Add one first.</p>
		{:else}
			<div class="spf-grid">
				{#each monitors as m (m.id)}
					<label class="spf-mon">
						<input
							type="checkbox"
							name="monitors"
							value={m.id}
							checked={values.monitors.includes(m.id)}
						/>
						<span>{m.name}</span>
					</label>
				{/each}
			</div>
		{/if}
		{#if errors.monitors}<span class="field-err field-err--flow">{errors.monitors}</span>{/if}
	</fieldset>
</div>

<style>
	.spf {
		display: flex;
		flex-direction: column;
		gap: 14px;
		min-width: 0;
	}
	.spf :global(.field) {
		margin-bottom: 0;
		max-width: 560px;
	}
	/* `.field` styles only inputs; the textarea matches them here. */
	.spf textarea {
		width: 100%;
		background: var(--surface);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-btn);
		padding: 10px 12px;
		font: inherit;
		font-size: 14px;
		color: var(--ink);
		resize: vertical;
	}
	.spf textarea:focus {
		outline: none;
		border-color: var(--accent);
		box-shadow: 0 0 0 3px var(--accent-wash);
	}
	.spf-hint {
		display: block;
		margin-top: 4px;
		font-size: 12px;
		color: var(--ink-3);
		overflow-wrap: anywhere;
	}
	.spf-slug {
		display: flex;
		align-items: stretch;
		min-width: 0;
	}
	.spf-slug__prefix {
		display: inline-flex;
		align-items: center;
		padding: 0 8px;
		border: 1px solid var(--border);
		border-inline-end: 0;
		border-radius: var(--radius-btn) 0 0 var(--radius-btn);
		color: var(--ink-3);
		font-size: 13px;
		white-space: nowrap;
	}
	.spf-slug input {
		flex: 1 1 auto;
		min-width: 0;
		border-start-start-radius: 0;
		border-end-start-radius: 0;
	}
	.spf-mons {
		border: 0;
		margin: 0;
		padding: 0;
		min-width: 0;
	}
	.spf-mons legend {
		font-size: 13px;
		font-weight: 560;
		color: var(--ink);
		padding: 0;
		margin-bottom: 4px;
	}
	.spf-note {
		font-size: 12px;
		color: var(--ink-3);
		margin: 0 0 10px;
	}
	.spf-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
		gap: 6px 16px;
	}
	.spf-mon {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 14px;
		color: var(--ink);
		min-width: 0;
	}
	.spf-mon span {
		overflow-wrap: anywhere;
	}
</style>
