<script lang="ts">
	import LegalPage from '$lib/components/legal/legal-page.svelte';
</script>

<LegalPage title="Privacy Policy" lastUpdated="2026-08-15">
	<h2>Who we are</h2>
	<p>
		nabz ("we", "us") is an uptime-monitoring service operated from the European Union and reachable
		at <a href="https://nabz.sh">nabz.sh</a>. This policy explains what personal data we collect,
		why, and your rights over it. Questions:
		<a href="mailto:privacy@nabz.sh">privacy@nabz.sh</a>.
	</p>

	<h2>What we collect</h2>
	<ul>
		<li>
			<strong>Account data</strong> — your email address, and an optional display name and avatar.
		</li>
		<li>
			<strong>Monitoring configuration</strong> — the URLs, hosts, and settings of the monitors you create,
			your alert channels (e.g. a webhook URL, a Slack/Telegram destination), and escalation policies.
		</li>
		<li>
			<strong>Monitoring results</strong> — the check results, incidents, and response-time history produced
			by running your monitors.
		</li>
		<li>
			<strong>Anonymous trials</strong> — if you use the "try it without signing up" feature, we
			store the single monitor you create against an opaque session token (no account, no personal
			data) and a one-way hash of your IP address for abuse control. This data is automatically
			deleted after <strong>one hour</strong>.
		</li>
	</ul>

	<h2>Why we process it</h2>
	<p>
		To provide the service: run your monitors, show you their status and history, and send the
		alerts you configure. We process this data to perform our contract with you and, for abuse
		prevention and security, on the basis of our legitimate interests. We do <strong>not</strong>
		sell your data or use it for advertising.
	</p>

	<h2>Where it is processed (sub-processors)</h2>
	<p>
		We host and process data with a small number of providers, chosen for EU data residency where
		possible:
	</p>
	<ul>
		<li><strong>Hetzner</strong> (Germany) — our servers and the PocketBase datastore.</li>
		<li>
			<strong>Cloudflare</strong> — serving and protecting the web application, and backup storage (R2).
		</li>
		<li>
			<strong>MailerSend</strong> — sending transactional and alert email (account verification, password
			resets, and your incident alerts).
		</li>
	</ul>

	<h2>Retention</h2>
	<p>
		Account and monitoring data is kept for as long as your account is active. Raw check results are
		retained for a rolling window and then summarised or removed. Anonymous-trial data is deleted
		within one hour. When you delete your account, we delete your associated data, subject to any
		short-lived backups (below).
	</p>

	<h2>Backups</h2>
	<p>
		We take automatic encrypted backups of the datastore for disaster recovery. Backups are rotated
		and deleted on a schedule, so deleted data may persist briefly in a backup before it ages out.
	</p>

	<h2>Your rights</h2>
	<p>
		If you are in the EU/EEA (or a comparable jurisdiction) you have the right to access, correct,
		export, or delete your personal data, and to object to or restrict certain processing. You can
		change your email, display name, and password from your account page, delete your account, or
		contact <a href="mailto:privacy@nabz.sh">privacy@nabz.sh</a> to exercise any of these rights.
	</p>

	<h2>Cookies</h2>
	<p>
		We use a small number of strictly-necessary cookies: a session cookie to keep you signed in, a
		security cookie for the sign-in flow, and — only if you use the anonymous trial — a signed
		session cookie holding the opaque trial token. We do not use advertising or third-party tracking
		cookies.
	</p>

	<h2>Changes</h2>
	<p>
		We may update this policy; the "last updated" date above reflects the current version. Material
		changes will be communicated through the service.
	</p>
</LegalPage>
