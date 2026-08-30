<script lang="ts">
	import { resolve } from '$app/paths';
	import { H3, Meta } from '$lib/components/common';
</script>

<Meta title="Reset password" />

<div class="max-w-sm mx-auto mt-8">
	<form class="flex flex-col space-y-3" method="POST">
		<H3>Forgot password? Let's create a new one.</H3>
		<label class="space-y-2 block">
			<span class="form-lbl">Your email</span>
			<input
				type="email"
				name="email"
				class="form-input block w-full"
				placeholder="Enter your email address"
				required
			/>
		</label>
		<button type="submit" class="btn btn-primary w-full justify-center"
			>Send me an email for password reset</button
		>
		<p class="text-gray-500 dark:text-gray-400">
			<a href={resolve('/signin')} class="text-primary-600 hover:underline dark:text-primary-500">
				Go back to login
			</a>
		</p>
	</form>
</div>
