<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { Meta, PageHeader } from '#lib/components/common/index.js';
	import { PLANS } from '#lib/plans.js';

	let { data, form } = $props();

	const cutoff = $derived(
		new Date(data.launchCutoff).toLocaleDateString(undefined, {
			year: 'numeric',
			month: 'short',
			day: 'numeric'
		})
	);
	const when = (iso: string) => new Date(iso.replace(' ', 'T')).toLocaleDateString();
</script>

<Meta title="Plans · Admin" />

<PageHeader
	title="Plans"
	sub="Set an account's plan by hand until billing is built. Nothing here charges anyone."
>
	{#snippet actions()}
		<a class="btn btn-ghost" href={resolve('/admin/usage')}>Usage</a>
	{/snippet}
</PageHeader>

{#if form?.message}
	<div
		class="alert-error"
		role="status"
		style={form.success
			? 'background:var(--up-wash);color:var(--up);border-color:var(--up-wash)'
			: ''}
	>
		{form.message}
	</div>
{/if}

<div class="card">
	<div class="card__h">
		<h3>Set a plan</h3>
		<span class="hint">by email or id</span>
	</div>
	<form class="ap-form" method="POST" action="?/setPlan" use:enhance>
		<div class="field">
			<label for="ap-email">Account email or id</label>
			<input
				id="ap-email"
				name="email"
				type="text"
				required
				autocomplete="off"
				value={form && 'email' in form ? (form.email ?? '') : ''}
			/>
		</div>
		<div class="field">
			<label for="ap-plan">Plan</label>
			<select id="ap-plan" name="plan" class="form-input">
				{#each Object.values(PLANS) as p (p.id)}
					<option value={p.id}>{p.name}</option>
				{/each}
			</select>
		</div>
		<div class="field ap-note">
			<label for="ap-note">Note <span class="opt">(optional)</span></label>
			<input id="ap-note" name="note" type="text" maxlength="500" placeholder="Why" />
		</div>
		<button type="submit" class="btn btn-primary">Save plan</button>
	</form>
	<p class="ap-hint">
		Accounts created before {cutoff} are on Pro without a row here. Setting Free on one of them takes
		that away. Accounts made with GitHub or Google hide their email from the app: give their account id
		instead.
	</p>
</div>

<div class="card">
	<div class="card__h">
		<h3>Set by hand</h3>
		<span class="hint">{data.rows.length}</span>
	</div>
	{#if data.rows.length === 0}
		<p class="ap-hint">No account has a plan set by hand yet.</p>
	{:else}
		<div class="ap-table-wrap">
			<table class="ap-table">
				<thead>
					<tr>
						<th>Account</th><th>Plan</th><th class="ap-wide">Source</th><th class="ap-wide">Note</th
						><th>Changed</th>
					</tr>
				</thead>
				<tbody>
					{#each data.rows as r (r.userId)}
						<tr>
							<td class="ap-email">{r.email || r.userId}</td>
							<td>{PLANS[r.plan].name}</td>
							<td class="ap-wide">{r.source}</td>
							<td class="ap-wide">{r.note}</td>
							<td>{when(r.updated)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>

<style>
	.ap-form {
		padding: 16px;
		display: grid;
		grid-template-columns: minmax(0, 2fr) minmax(0, 1fr) minmax(0, 2fr) auto;
		gap: 12px;
		align-items: end;
	}
	.ap-form :global(.field) {
		margin-bottom: 0;
	}
	.ap-hint {
		font-size: 12px;
		color: var(--ink-3);
		margin: 0;
		padding: 0 16px 16px;
	}
	.ap-table-wrap {
		overflow-x: auto;
		padding: 0 16px 16px;
	}
	.ap-table {
		width: 100%;
		border-collapse: collapse;
		font-size: 13px;
	}
	.ap-table th {
		text-align: start;
		font-weight: 560;
		color: var(--ink-3);
		font-size: 12px;
		padding: 8px 8px 8px 0;
		border-bottom: 1px solid var(--border);
	}
	.ap-table td {
		padding: 8px 8px 8px 0;
		border-bottom: 1px solid var(--border);
		color: var(--ink);
	}
	.ap-email {
		overflow-wrap: anywhere;
	}
	@media (max-width: 560px) {
		/* Account, plan and date are what matter on a phone; the rest wrapped the
		   table into a column of single words. */
		.ap-wide {
			display: none;
		}
	}
	@media (max-width: 720px) {
		.ap-form {
			grid-template-columns: 1fr;
			align-items: stretch;
		}
	}
</style>
