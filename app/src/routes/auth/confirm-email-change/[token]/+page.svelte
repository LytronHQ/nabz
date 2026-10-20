<script lang="ts">
	import { resolve } from '$app/paths';
	import { Alert, AuthCard, Meta } from '#lib/components/common/index.js';
	import type { ActionData } from './$types';

	interface Props {
		form: ActionData;
	}

	let { form }: Props = $props();
</script>

<Meta title="Confirm email change" />

<AuthCard
	title="Confirm your email change"
	sub="Enter your current password to finish changing your email address."
>
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
			<label for="password">Password</label>
			<input
				id="password"
				type="password"
				name="password"
				autocomplete="current-password"
				required
			/>
		</div>
		<button type="submit" class="btn btn-primary btn-block">Confirm change</button>
	</form>
	<p class="auth-alt"><a href={resolve('signin')}>Back to sign in</a></p>
</AuthCard>
