<script lang="ts">
	import { resolve } from '$app/paths';
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { enhance, applyAction } from '$app/forms';
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

<Meta title="Sign up" />

<div class="auth-wrap">
	<form
		class="auth-card"
		method="POST"
		use:enhance={() => {
			return async ({ result }) => {
				if (result.type === 'success' && result.data?.success) {
					form = {
						success: true,
						message:
							'You have successfully registered. Please check your email to verify your account.'
					};
					setTimeout(() => goto(resolve('/signin')), 3000);
					return;
				}
				await applyAction(result);
			};
		}}
	>
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

		<h1>Create your account</h1>
		<p class="sub">Start monitoring in minutes.</p>

		{#if form?.message}
			<div
				class="alert-error"
				style={form.success
					? 'background:var(--up-wash);color:var(--up);border-color:var(--up-wash)'
					: ''}
			>
				{form.message}
				{#if form.errors}
					<ul style="margin:6px 0 0;padding-left:18px">
						{#each form.errors as error, i (i)}
							<li>{error.field}: {error.message}</li>
						{/each}
					</ul>
				{/if}
			</div>
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
				autocomplete="new-password"
			/>
		</div>
		<div class="field">
			<label for="confirmPassword">Confirm password</label>
			<input
				id="confirmPassword"
				type="password"
				name="confirmPassword"
				placeholder="••••••••"
				required
				autocomplete="new-password"
			/>
		</div>

		<button
			type="submit"
			class="btn btn-primary btn-block"
			style="margin-top:6px"
			onclick={clearForm}>Sign up</button
		>

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

		<p class="auth-alt">Already have an account? <a href={resolve('/signin')}>Sign in</a></p>
	</form>
</div>
