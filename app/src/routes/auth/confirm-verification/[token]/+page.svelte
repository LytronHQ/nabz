<script lang="ts">
	import { resolve } from '$app/paths';
	import type { PageData } from './$types';
	import { Alert, AuthCard, Meta } from '#lib/components/common/index.js';

	interface Props {
		data: PageData;
	}

	let { data }: Props = $props();
</script>

<Meta title="Account Confirmation" />

<AuthCard title="Account confirmation">
	{#if data?.message}
		<Alert tone={data.success ? 'success' : 'error'}>
			{data.message}
		</Alert>
	{/if}
	<p class="auth-alt"><a href={resolve('signin')}>Back to sign in</a></p>
</AuthCard>
