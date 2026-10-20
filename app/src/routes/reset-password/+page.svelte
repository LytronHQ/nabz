<script lang="ts">
	import { resolve } from '$app/paths';
	import { AuthCard, Meta } from '#lib/components/common/index.js';
</script>

<Meta title="Reset password" />

<AuthCard title="Forgot your password?" sub="We'll email you a link to set a new one.">
	<form method="POST">
		<div class="field">
			<label for="email">Your email</label>
			<input
				id="email"
				type="email"
				name="email"
				placeholder="you@example.com"
				autocomplete="email"
				required
			/>
		</div>
		<button type="submit" class="btn btn-primary btn-block"
			>Send me an email for password reset</button
		>
	</form>
	<p class="auth-alt"><a href={resolve('signin')}>Back to sign in</a></p>
</AuthCard>
