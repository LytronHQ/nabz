<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/stores';
	import { Appearance } from '$lib/components/common/appearance';
	import { Icon } from '$lib/components/common/icon';

	interface Props {
		user?: any;
		isAdmin?: boolean;
	}

	let { user = null, isAdmin = false }: Props = $props();

	// Take `path` as an argument so the template expression depends on it and
	// re-evaluates on navigation (Svelte doesn't trace vars used inside a fn body).
	let path = $derived($page.url.pathname);
	const isActive = (p: string, href: string) => (href === '/' ? p === '/' : p.startsWith(href));
</script>

<aside class="side">
	<a class="brand" href={resolve('/dashboard')}>
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
		<b>nabz</b>
	</a>

	<nav class="nav">
		<a
			href={resolve('/dashboard')}
			class:active={isActive(path, '/dashboard')}
			aria-current={isActive(path, '/dashboard') ? 'page' : undefined}
		>
			<Icon name="dashboard" />
			Dashboard
		</a>
		<a
			href={resolve('/monitors')}
			class:active={isActive(path, '/monitors')}
			aria-current={isActive(path, '/monitors') ? 'page' : undefined}
		>
			<Icon name="activity" />
			Monitors
		</a>
		<a
			href={resolve('/incidents')}
			class:active={isActive(path, '/incidents')}
			aria-current={isActive(path, '/incidents') ? 'page' : undefined}
		>
			<Icon name="incidents" />
			Incidents
		</a>
		<a
			href={resolve('/alerts')}
			class:active={isActive(path, '/alerts')}
			aria-current={isActive(path, '/alerts') ? 'page' : undefined}
		>
			<Icon name="alerts" />
			Alerts
		</a>
		<a
			href={resolve('/escalations')}
			class:active={isActive(path, '/escalations')}
			aria-current={isActive(path, '/escalations') ? 'page' : undefined}
		>
			<Icon name="escalations" />
			Escalations
		</a>
		{#if isAdmin}
			<a
				href={resolve('/admin/usage')}
				class:active={isActive(path, '/admin')}
				aria-current={isActive(path, '/admin') ? 'page' : undefined}
			>
				<Icon name="usage" />
				Usage
			</a>
		{/if}
	</nav>

	<div class="side__foot">
		<Appearance />
		<a href={resolve('/logout')} class="nav-signout">
			<Icon name="signout" />
			Sign out
		</a>
		<a
			class="side__user"
			href={resolve('/account')}
			class:active={isActive(path, '/account')}
			aria-current={isActive(path, '/account') ? 'page' : undefined}
		>
			<span
				class="avatar"
				style={user?.avatar
					? `background-image:url('${user.avatar}');background-size:cover;background-position:center`
					: ''}
			></span>
			<span class="who">
				<b>{user?.name || 'Account'}</b>
				<span>{user?.email || ''}</span>
			</span>
		</a>
	</div>
</aside>

<style>
	.nav-signout {
		display: flex;
		align-items: center;
		gap: 11px;
		padding: 9px 11px;
		border-radius: var(--radius-btn);
		color: var(--ink-2);
		text-decoration: none;
		font-size: 13.5px;
		font-weight: 480;
	}
	.nav-signout:hover {
		background: var(--surface-2);
		color: var(--ink);
	}
	.nav-signout :global(svg) {
		width: 16px;
		height: 16px;
		opacity: 0.85;
		flex: 0 0 16px;
	}
	a.side__user {
		text-decoration: none;
		color: inherit;
		border-radius: var(--radius-btn);
	}
	a.side__user:hover {
		background: var(--surface-2);
	}
	a.side__user.active {
		background: var(--accent-wash);
	}
</style>
