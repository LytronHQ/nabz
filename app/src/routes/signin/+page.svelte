<script lang="ts">
	import { resolve } from '$app/paths';
	import type { ActionData, PageData } from './$types';
	import { Alert, Meta, OAuthButtons } from '#lib/components/common/index.js';

	interface Props {
		data: PageData;
		form: ActionData;
	}

	let { data, form = $bindable() }: Props = $props();

	function clearForm() {
		form = null;
	}
</script>

<Meta title="Sign in" />

<div class="auth-wrap">
	<form class="auth-card" method="POST">
		<div class="auth-brand">
			<span class="mark">
				<svg
					viewBox="0 0 24 24"
					fill="none"
					stroke="#fff"
					stroke-width="2.4"
					stroke-linecap="round"
					stroke-linejoin="round"><path d="M3 12h4l2.5-7 5 14 2.5-7H21"></path></svg
				>
			</span>
			<b style="font-size:14.5px">nabz</b>
		</div>

		<h1>Welcome back</h1>
		<p class="sub">Sign in to your account.</p>

		{#if form?.message}
			<div class="alert-error">{form.message}</div>
		{:else if data.oauth === 'failed'}
			<div class="alert-error">
				That sign-in didn't complete. Please try again, or sign in with your email.
			</div>
		{:else if data.oauth === 'cancelled'}
			<!-- Cancelling is the user's choice, not an error: neutral, not red. -->
			<div class="oauth-note"><Alert>Sign-in was cancelled. Nothing was changed.</Alert></div>
		{/if}

		<OAuthButtons providers={data.providers ?? []} />

		<div class="field">
			<label for="email">Email</label>
			<input
				id="email"
				type="email"
				name="email"
				placeholder="you@example.com"
				required
				autocomplete="email"
			/>
		</div>
		<div class="field">
			<label for="password">Password</label>
			<input
				id="password"
				type="password"
				name="password"
				placeholder="••••••••"
				required
				autocomplete="current-password"
			/>
		</div>

		<div style="text-align:right;margin:-4px 0 16px">
			<a href={resolve('reset-password')} style="font-size:12.5px">Forgot password?</a>
		</div>

		<button type="submit" class="btn btn-primary btn-block" onclick={clearForm}>Sign in</button>

		<p class="auth-alt">
			Don't have an account?
			<a href={resolve('signup')}>Sign up</a>
		</p>
	</form>
</div>

<style>
	.oauth-note {
		margin-bottom: 14px;
	}
</style>
