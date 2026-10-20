<script lang="ts">
	import { resolve } from '$app/paths';
	import { Alert, AuthCard, Meta } from '#lib/components/common/index.js';
</script>

<Meta title="Reset password" />

<AuthCard title="Check your email">
	<Alert tone="success">
		If you have an account with us, you will receive an email with instructions for resetting your
		password.
	</Alert>
	<p class="auth-alt"><a href={resolve('signin')}>Back to sign in</a></p>
</AuthCard>
