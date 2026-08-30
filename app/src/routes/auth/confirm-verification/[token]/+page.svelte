<script lang="ts">
	import { resolve } from '$app/paths';
	import type { PageData } from './$types';
	import { Alert, Meta } from '$lib/components/common';

	interface Props {
		data: PageData;
	}

	let { data }: Props = $props();
</script>

<Meta title="Account Confirmation" />

<div class="max-w-sm mx-auto mt-8">
	{#if data}
		{#if data.message}
			<Alert tone={data.success ? 'success' : 'error'}>
				{data.message}
			</Alert>
		{/if}
	{/if}
	<p class="text-gray-500 dark:text-gray-400">
		<a href={resolve('/signin')} class="text-primary-600 hover:underline dark:text-primary-500">
			Go back to login
		</a>
	</p>
</div>
