<script lang="ts">
	import { resolve } from '$app/paths';
	import { Alert, Meta } from '$lib/components/common';
</script>

<Meta title="Reset password" />

<div class="max-w-sm mx-auto mt-8">
	<Alert tone="success">
		If you have an account with us, you will receive and email with instructions for resetting your
		password.
	</Alert>
	<p class="text-gray-500 dark:text-gray-400">
		<a href={resolve('/signin')} class="text-primary-600 hover:underline dark:text-primary-500">
			Go back to login
		</a>
	</p>
</div>
