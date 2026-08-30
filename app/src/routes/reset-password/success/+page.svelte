<script lang="ts">
	import { resolve } from '$app/paths';
	import { Alert, Meta } from '$lib/components/common';
</script>

<Meta title="Reset password" />

<div class="max-w-sm mx-auto mt-8">
	<Alert tone="success">
		Successfully changed the user password. You can now sign in with your new password.
	</Alert>
	<p class="text-gray-500 dark:text-gray-400">
		<a href={resolve('/signin')} class="text-primary-600 hover:underline dark:text-primary-500">
			Go back to login
		</a>
	</p>
</div>
