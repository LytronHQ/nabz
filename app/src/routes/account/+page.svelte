<script lang="ts">
	import { enhance } from '$app/forms';
	import { Meta, PageHeader, Pill } from '$lib/components/common';
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

	function onAvatarChange(e: Event) {
		const file = (e.currentTarget as HTMLInputElement).files?.[0];
		avatarPreview = file ? URL.createObjectURL(file) : null;
	}
</script>

<Meta title="Account" />

<PageHeader title="Account" sub="Manage your profile, sign-in email, and password." />

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
	.acct-remove {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		font-size: 12px;
		color: var(--ink-3);
	}
</style>
