<script lang="ts">
	import { resolve } from '$app/paths';
	import { H3, Meta, Alert } from '$lib/components/common';
	import type { ActionData, PageData } from './$types';

	interface Props {
		data: PageData;
		form: ActionData;
	}

	let { data, form }: Props = $props();
</script>

<Meta title="Reset password" />

<div class="max-w-sm mx-auto mt-8">
	<form class="flex flex-col space-y-3" method="POST">
		{#if form}
			{#if form.message}
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
		{/if}
		<H3>Reset password for <b>{data.email}</b></H3>
		<label class="space-y-2 block">
			<span class="form-lbl">New password</span>
			<input type="password" name="password" class="form-input block w-full" required />
		</label>
		<label class="space-y-2 block">
			<span class="form-lbl">New password confirm</span>
			<input type="password" name="confirmPassword" class="form-input block w-full" required />
		</label>
		<button type="submit" class="btn btn-primary w-full justify-center">Set new password</button>
		<p class="text-gray-500 dark:text-gray-400">
			<a href={resolve('/signin')} class="text-primary-600 hover:underline dark:text-primary-500">
				Or go back to login
			</a>
		</p>
	</form>
</div>
