<script lang="ts">
	import { resolve } from '$app/paths';
	import { Alert, AuthCard, Meta } from '#lib/components/common/index.js';
	import type { ActionData, PageData } from './$types';

	interface Props {
		data: PageData;
		form: ActionData;
	}

	let { data, form }: Props = $props();
</script>

<Meta title="Reset password" />

{#if data.email}
	<AuthCard title="Set a new password" sub="For {data.email}">
		<form method="POST">
			{#if form?.message}
				<Alert tone={form.success ? 'success' : 'error'}>
					{form.message}
					{#if form.errors}
						<ul class="list-disc ms-4 mt-1">
							{#each form.errors as error, i (i)}
								<li>{error.field}: {error.message}</li>
							{/each}
						</ul>
					{/if}
				</Alert>
			{/if}
			<div class="field">
				<label for="password">New password</label>
				<input id="password" type="password" name="password" autocomplete="new-password" required />
			</div>
			<div class="field">
				<label for="confirmPassword">Confirm new password</label>
				<input
					id="confirmPassword"
					type="password"
					name="confirmPassword"
					autocomplete="new-password"
					required
				/>
			</div>
			<button type="submit" class="btn btn-primary btn-block">Set new password</button>
		</form>
		<p class="auth-alt"><a href={resolve('signin')}>Back to sign in</a></p>
	</AuthCard>
{:else}
	<AuthCard title="This link doesn't work">
		<Alert tone="error">
			This password reset link is invalid or incomplete. Reset links are single-use and expire — ask
			for a new one.
		</Alert>

		<a class="btn btn-primary btn-block" href={resolve('reset-password')}>Send a new link</a>

		<p class="auth-alt"><a href={resolve('signin')}>Back to sign in</a></p>
	</AuthCard>
{/if}
