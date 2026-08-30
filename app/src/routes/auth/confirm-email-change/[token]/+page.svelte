<script lang="ts">
	import { resolve } from '$app/paths';
	import { H3, Meta, Alert } from '$lib/components/common';
	import type { ActionData } from './$types';

	interface Props {
		form: ActionData;
	}

	let { form }: Props = $props();
</script>

<Meta title="Confirm email change" />

<div class="max-w-sm mx-auto mt-8">
	<form class="flex flex-col space-y-3" method="POST">
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
		<H3>Confirm your email change</H3>
		<p class="text-gray-500 text-sm">
			Enter your current password to finish changing your email address.
		</p>
		<label class="space-y-2 block">
			<span class="form-lbl">Password</span>
			<input type="password" name="password" class="form-input block w-full" required />
		</label>
		<button type="submit" class="btn btn-primary w-full justify-center">Confirm change</button>
		<p class="text-gray-500 dark:text-gray-400">
			<a href={resolve('/signin')} class="text-primary-600 hover:underline dark:text-primary-500"
				>Back to sign in</a
			>
		</p>
	</form>
</div>
