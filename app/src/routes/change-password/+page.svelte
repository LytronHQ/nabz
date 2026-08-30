<script lang="ts">
	import { resolve } from '$app/paths';
	import { Meta, PageHeader } from '$lib/components/common';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<!-- Composed from the global primitives in app.css (card / card__h / field /
     btn / alert-error), the same ones /account uses for this identical form. No
     scoped <style> here on purpose: the first version of this page carried its
     own, which Svelte scopes — so it shadowed the real `.card` and left the
     inputs and button with no design-system styling at all (#396). -->

<Meta title="Change password" />

<PageHeader
	title="Change your password"
	sub={data.forced
		? 'This account still has its shared default password.'
		: 'Choose a new password for your account.'}
/>

{#if form?.message}
	<div class="alert-error">{form.message}</div>
{/if}

<div class="card">
	<div class="card__h">
		<h3>New password</h3>
		{#if data.forced}
			<!-- Say why they are here. A form with no explanation, on a page nothing
			     else links to, reads as a bug rather than a requirement. -->
			<span class="hint">Nothing else is available until you change it</span>
		{/if}
	</div>

	<div class="cp-body">
		<form method="POST">
			<div class="field">
				<label for="oldPassword">Current password</label>
				<input
					id="oldPassword"
					name="oldPassword"
					type="password"
					autocomplete="current-password"
					required
				/>
			</div>
			<div class="field">
				<label for="password">New password</label>
				<input
					id="password"
					name="password"
					type="password"
					autocomplete="new-password"
					minlength="8"
					required
				/>
			</div>
			<div class="field">
				<label for="passwordConfirm">Confirm new password</label>
				<input
					id="passwordConfirm"
					name="passwordConfirm"
					type="password"
					autocomplete="new-password"
					minlength="8"
					required
				/>
			</div>
			<div class="cp-actions">
				<button type="submit" class="btn btn-primary">Change password</button>
				<!-- Always reachable, even while the gate is up: a user who cannot
				     complete this must still be able to leave. -->
				<a class="btn btn-ghost" href={resolve('/logout')}>Sign out</a>
			</div>
		</form>
	</div>
</div>

<style>
	/* Layout only — the same wrapper /account uses around this identical form, so
	   the two match. Nothing here re-declares a design-system class: without it the
	   fields sit flush against the card edge and stretch the full width of the
	   content area, which is what a 1000px-wide password box looks like. */
	.cp-body {
		padding: 16px;
		display: flex;
		flex-direction: column;
		align-items: flex-start;
	}
	.cp-body form {
		display: flex;
		flex-direction: column;
		gap: 14px;
		align-items: flex-start;
		width: 100%;
	}
	.cp-body :global(.field) {
		margin-bottom: 0;
		width: 100%;
		max-width: 420px;
	}
	.cp-actions {
		display: flex;
		gap: 8px;
		align-items: center;
	}
</style>
