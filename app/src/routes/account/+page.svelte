<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { Meta, PageHeader, Pill, ProviderMark } from '#lib/components/common/index.js';
	import { providerLabel } from '#lib/utils/oauth-providers.js';
	import type { ActionData, PageData } from './$types';

	interface Props {
		data: PageData;
		form: ActionData;
	}

	let { data, form }: Props = $props();

	let user = $derived(data.user);
	let formErrors = $derived(
		(form as { errors?: { field: string; message: string }[] } | null)?.errors
	);
	let avatarPreview: string | null = $state(null);

	// What /auth/callback reported after a Connect from this page (#622).
	let connectMessage = $derived.by(() => {
		const c = data.connect;
		if (!c) return null;
		const name = providerLabel(c.provider || 'that provider');
		switch (c.outcome) {
			case 'connected':
				return { ok: true, text: `${name} is connected. You can now sign in with it.` };
			case 'cancelled':
				return { ok: true, text: `Connecting ${name} was cancelled. Nothing was changed.` };
			case 'taken':
				return {
					ok: false,
					text: `That ${name} account is already connected to another nabz account, so it was not connected here. Sign in to that account and disconnect it there first.`
				};
			default:
				return { ok: false, text: "Connecting didn't complete. Please try again." };
		}
	});

	const since = (iso: string | null) =>
		iso
			? new Date(iso.replace(' ', 'T')).toLocaleDateString(undefined, {
					year: 'numeric',
					month: 'short',
					day: 'numeric'
				})
			: '';

	function onAvatarChange(e: Event) {
		const file = (e.currentTarget as HTMLInputElement).files?.[0];
		avatarPreview = file ? URL.createObjectURL(file) : null;
	}
</script>

<Meta title="Account" />

<PageHeader title="Account" sub="Manage your profile, email, password, and how you sign in." />

{#if !form?.message && connectMessage}
	<div
		class="alert-error"
		style={connectMessage.ok
			? 'background:var(--up-wash);color:var(--up);border-color:var(--up-wash)'
			: ''}
	>
		{connectMessage.text}
	</div>
{/if}

{#if form?.message}
	<div
		class="alert-error"
		style={form.success
			? 'background:var(--up-wash);color:var(--up);border-color:var(--up-wash)'
			: ''}
	>
		{form.message}
		{#if formErrors}
			<ul style="margin:6px 0 0;padding-left:18px">
				{#each formErrors as error, i (i)}
					<li>{error.field}: {error.message}</li>
				{/each}
			</ul>
		{/if}
	</div>
{/if}

<!-- Profile -->
<div class="card">
	<div class="card__h">
		<h3>Profile</h3>
		<span class="hint">name &amp; avatar</span>
	</div>
	<div class="acct-body">
		<form method="POST" action="?/updateProfile" enctype="multipart/form-data" use:enhance>
			<div class="acct-avatar">
				{#if avatarPreview || user?.avatar}
					<img class="acct-avatar__img" src={avatarPreview || user?.avatar} alt="Your avatar" />
				{:else}
					<span class="acct-avatar__ph"></span>
				{/if}
				<div class="acct-avatar__ctl">
					<label class="btn btn-ghost" for="avatar">Choose image…</label>
					<input
						id="avatar"
						name="avatar"
						type="file"
						accept="image/*"
						onchange={onAvatarChange}
						hidden
					/>
					{#if user?.avatar}
						<label class="acct-remove"
							><input type="checkbox" name="removeAvatar" /> Remove current avatar</label
						>
					{/if}
				</div>
			</div>
			<div class="field">
				<label for="name">Display name</label>
				<input
					id="name"
					name="name"
					type="text"
					value={user?.name ?? ''}
					placeholder="Your name"
					autocomplete="name"
				/>
			</div>
			<button type="submit" class="btn btn-primary">Save profile</button>
		</form>
	</div>
</div>

<!-- Email -->
<div class="card">
	<div class="card__h">
		<h3>Email</h3>
		{#if user?.verified}
			<Pill tone="up" label="Verified" />
		{:else}
			<Pill tone="pending" label="Unverified" />
		{/if}
	</div>
	<div class="acct-body">
		<div class="field">
			<label for="current-email">Current email</label>
			<div id="current-email" class="mono acct-current">{user?.email}</div>
		</div>
		{#if !user?.verified}
			<form method="POST" action="?/resendVerification" use:enhance>
				<button type="submit" class="btn btn-ghost">Resend verification email</button>
			</form>
		{/if}
		<form method="POST" action="?/changeEmail" use:enhance>
			<div class="field">
				<label for="newEmail">New email</label>
				<input
					id="newEmail"
					name="newEmail"
					type="email"
					placeholder="new@example.com"
					autocomplete="email"
					required
				/>
			</div>
			<button type="submit" class="btn btn-primary">Change email</button>
			<p class="acct-note">
				We'll email a confirmation link to the new address; the change takes effect once you open
				it.
			</p>
		</form>
	</div>
</div>

<!-- Sign-in methods (#622) -->
{#if data.signInMethods.length}
	<div class="card">
		<div class="card__h">
			<h3>Sign-in methods</h3>
			<span class="hint">ways into this account</span>
		</div>
		<div class="acct-body">
			<ul class="acct-methods">
				<li>
					<span class="acct-method__name">Email and password</span>
					<span class="acct-method__state">Always on</span>
				</li>
				{#each data.signInMethods as method (method.provider)}
					<li>
						<span class="acct-method__name">
							<ProviderMark name={method.provider} />
							{providerLabel(method.provider)}
						</span>
						{#if method.linkId}
							<span class="acct-method__state">
								<Pill tone="up" label="Connected" />
								<span class="acct-method__since">since {since(method.since)}</span>
							</span>
							<form method="POST" action="?/disconnect" use:enhance>
								<input type="hidden" name="linkId" value={method.linkId} />
								<button
									type="submit"
									class="btn btn-ghost"
									aria-label={`Disconnect ${providerLabel(method.provider)}`}>Disconnect</button
								>
							</form>
						{:else}
							<span class="acct-method__state">Not connected</span>
							<a
								class="btn btn-ghost"
								href={resolve('/auth/connect/[provider]', { provider: method.provider })}
								data-sveltekit-reload
								aria-label={`Connect ${providerLabel(method.provider)}`}>Connect</a
							>
						{/if}
					</li>
				{/each}
			</ul>
			{#if data.signInMethodsError}
				<p class="acct-note">
					Couldn't load which of these are connected right now. Reload the page to try again.
				</p>
			{:else}
				<p class="acct-note">
					Connecting works even when that account uses a different email. After a disconnect you can
					still sign in with your email and password, or reset the password by email.
				</p>
			{/if}
		</div>
	</div>
{/if}

<!-- Password -->
<div class="card">
	<div class="card__h">
		<h3>Password</h3>
		<span class="hint">change or reset</span>
	</div>
	<div class="acct-body">
		<form method="POST" action="?/changePassword" use:enhance>
			<div class="field">
				<label for="oldPassword">Current password</label>
				<input
					id="oldPassword"
					name="oldPassword"
					type="password"
					autocomplete="current-password"
					required
				/>
			</div>
			<div class="field">
				<label for="password">New password</label>
				<input id="password" name="password" type="password" autocomplete="new-password" required />
			</div>
			<div class="field">
				<label for="passwordConfirm">Confirm new password</label>
				<input
					id="passwordConfirm"
					name="passwordConfirm"
					type="password"
					autocomplete="new-password"
					required
				/>
			</div>
			<button type="submit" class="btn btn-primary">Change password</button>
		</form>
		<div class="acct-divider"></div>
		<form method="POST" action="?/sendPasswordReset" use:enhance>
			<p class="acct-note">Prefer a reset link by email instead?</p>
			<button type="submit" class="btn btn-ghost">Send password-reset link</button>
		</form>
	</div>
</div>

<style>
	.acct-body {
		padding: 16px;
		display: flex;
		flex-direction: column;
		gap: 14px;
		align-items: flex-start;
	}
	.acct-body form {
		display: flex;
		flex-direction: column;
		gap: 14px;
		align-items: flex-start;
		width: 100%;
	}
	.acct-body :global(.field) {
		margin-bottom: 0;
		width: 100%;
		max-width: 420px;
	}
	.acct-current {
		font-size: 14px;
		color: var(--ink);
	}
	.acct-note {
		font-size: 12px;
		color: var(--ink-3);
		margin: 0;
	}
	.acct-divider {
		height: 1px;
		background: var(--border);
		width: 100%;
		margin: 4px 0;
	}
	.acct-avatar {
		display: flex;
		flex-direction: row;
		align-items: center;
		gap: 16px;
	}
	.acct-avatar__img,
	.acct-avatar__ph {
		width: 64px;
		height: 64px;
		border-radius: 50%;
		flex: 0 0 64px;
		object-fit: cover;
		border: 1px solid var(--border);
	}
	.acct-avatar__ph {
		background: conic-gradient(from 200deg, var(--accent), var(--up), var(--pending));
	}
	.acct-avatar__ctl {
		display: flex;
		flex-direction: column;
		gap: 8px;
		align-items: flex-start;
	}
	.acct-methods {
		list-style: none;
		margin: 0;
		padding: 0;
		width: 100%;
		max-width: 560px;
	}
	.acct-methods li {
		display: grid;
		grid-template-columns: 1fr auto auto;
		align-items: center;
		gap: 12px;
		padding: 10px 0;
		border-bottom: 1px solid var(--border);
		min-height: 52px;
	}
	.acct-methods li:last-child {
		border-bottom: 0;
	}
	.acct-methods li form {
		width: auto;
	}
	.acct-method__name {
		display: inline-flex;
		align-items: center;
		gap: 9px;
		font-size: 14px;
		font-weight: 560;
		color: var(--ink);
	}
	.acct-method__name :global(svg) {
		width: 18px;
		height: 18px;
		flex: 0 0 18px;
	}
	.acct-method__state {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		font-size: 12.5px;
		color: var(--ink-3);
	}
	.acct-method__since {
		white-space: nowrap;
	}
	@media (max-width: 560px) {
		.acct-methods li {
			grid-template-columns: 1fr auto;
		}
		.acct-method__state {
			grid-column: 1;
			grid-row: 2;
		}
		.acct-methods li > form,
		.acct-methods li > a {
			grid-column: 2;
			grid-row: 1 / span 2;
		}
	}
	.acct-remove {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		font-size: 12px;
		color: var(--ink-3);
	}
</style>
