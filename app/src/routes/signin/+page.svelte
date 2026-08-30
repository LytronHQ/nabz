<script lang="ts">
	import { resolve } from '$app/paths';
	import { browser } from '$app/environment';
	import Icon from '@iconify/svelte';
	import type { ActionData, PageData } from './$types';
	import { createAuthCookie, type AuthProviderCallbackData } from '$lib/utils/auth-cookie-utils';
	import { Meta } from '$lib/components/common';

	interface Props {
		data: PageData;
		form: ActionData;
	}

	let { data, form = $bindable() }: Props = $props();

	function clearForm() {
		form = null;
	}

	function gotoAuthProvider(provider: AuthProviderCallbackData) {
		if (browser) {
			createAuthCookie(provider, data.key);
		}
		window.location.href = provider.redirectUrl || '';
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
					stroke-linejoin="round"><path d="M3 12h4l2.5-7 5 14 2.5-7H21" /></svg
				>
			</span>
			<b style="font-size:14.5px">nabz</b>
		</div>

		<h1>Welcome back</h1>
		<p class="sub">Sign in to your account.</p>

		{#if form?.message}
			<div class="alert-error">{form.message}</div>
		{/if}

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
			<a href={resolve('/reset-password')} style="font-size:12.5px">Forgot password?</a>
		</div>

		<button type="submit" class="btn btn-primary btn-block" onclick={clearForm}>Sign in</button>

		{#if data.providers && data.providers.length}
			<div style="display:flex;align-items:center;gap:10px;margin:18px 0 4px">
				<span style="flex:1;height:1px;background:var(--border)"></span>
				<span class="mono" style="font-size:11px;color:var(--ink-3)">or continue with</span>
				<span style="flex:1;height:1px;background:var(--border)"></span>
			</div>
			<div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap">
				{#each data.providers as provider (provider.name)}
					<button
						type="button"
						class="icon-btn"
						title={provider.name}
						onclick={() => gotoAuthProvider(provider)}
					>
						<Icon width="22" icon={'devicon:' + provider.name} />
					</button>
				{/each}
			</div>
		{/if}

		<p class="auth-alt">Don't have an account? <a href={resolve('/signup')}>Sign up</a></p>
	</form>
</div>
