<script lang="ts">
	import { resolve } from '$app/paths';
	import { Alert, AuthCard, Meta } from '#lib/components/common/index.js';
</script>

<Meta title="Reset password" />

<AuthCard title="Password changed">
	<Alert tone="success"
		>Successfully changed the user password. You can now sign in with your new password.</Alert
	>

	<a class="btn btn-primary btn-block" href={resolve('signin')}>Sign in</a>
</AuthCard>
