import { test, expect, type Page } from '@playwright/test';
import { signIn } from './helpers';

// Form BEHAVIOUR journeys. The older journeys stayed on each form's default type
// ("no custom Select interaction is needed"), so when the Svelte 5 migration made
// the forms stop reacting to their own fields, every journey kept passing — and
// production shipped a Telegram channel form that still asked for a Webhook URL.
// These change the fields the way a user does and assert the form follows.

const FIXTURE = 'http://fixture:8080';
// Unique per run: a run that fails midway leaves its records behind, and a second
// row with the same name makes every later row lookup ambiguous.
const RUN = Date.now().toString(36);

// Every alert channel type: the fields it must show, and valid values for them.
const CHANNELS: {
	type: string;
	fields: Record<string, string>;
}[] = [
	{ type: 'email', fields: { 'Email address': 'e2e-alerts@example.com' } },
	{ type: 'webhook', fields: { 'Webhook URL': `${FIXTURE}/echo` } },
	{
		type: 'slack',
		fields: {
			'Slack incoming webhook URL': 'https://hooks.slack.com/services/T0/B0/x'
		}
	},
	{
		type: 'discord',
		fields: { 'Discord webhook URL': 'https://discord.com/api/webhooks/1/x' }
	},
	{
		type: 'telegram',
		fields: { 'Bot token': '123456:ABC-def_1', 'Chat ID': '-1001234567890' }
	},
	{
		type: 'pagerduty',
		fields: { 'Integration routing key': 'e2e0123456789abcdef0123456789abc' }
	}
];
const ALL_LABELS = [...new Set(CHANNELS.flatMap((c) => Object.keys(c.fields)))];

async function expectOnlyFields(scope: ReturnType<Page['getByRole']>, want: string[]) {
	for (const label of ALL_LABELS) {
		const lbl = scope.locator('.form-lbl').getByText(label, { exact: true });
		if (want.includes(label)) await expect(lbl).toBeVisible();
		else await expect(lbl).toHaveCount(0);
	}
}

for (const ch of CHANNELS) {
	test(`alert channel: ${ch.type} — type switch shows its fields, then add, edit, delete`, async ({
		page
	}) => {
		await signIn(page);
		await page.goto('/alerts');
		const name = `e2e-${ch.type}-channel-${RUN}`;

		await page.getByRole('button', { name: 'Add channel', exact: true }).click();
		const dialog = page.getByRole('dialog');
		await dialog.getByPlaceholder('e.g. On-call Slack').fill(name);
		await dialog.locator('select').selectOption(ch.type);
		await expectOnlyFields(dialog, Object.keys(ch.fields));
		for (const [label, value] of Object.entries(ch.fields)) {
			// Not exact: the Chat ID label also wraps its Detect button and a hint.
			await dialog.getByLabel(label).fill(value);
		}
		await dialog.getByRole('button', { name: 'Add Channel', exact: true }).click();

		const row = page.getByRole('row').filter({ hasText: name });
		await expect(row).toBeVisible();
		await expect(row).toContainText(ch.type);

		// Edit: the modal opens on this channel's own fields and values, and a
		// rename is saved.
		await row.getByRole('button', { name: 'Edit' }).click();
		const edit = page.getByRole('dialog');
		await expectOnlyFields(edit, Object.keys(ch.fields));
		for (const [label, value] of Object.entries(ch.fields)) {
			await expect(edit.getByLabel(label)).toHaveValue(value);
		}
		await edit.getByPlaceholder('e.g. On-call Slack').fill(`${name}-renamed`);
		await edit.getByRole('button', { name: 'Save', exact: true }).click();
		const renamed = page.getByRole('row').filter({ hasText: `${name}-renamed` });
		await expect(renamed).toBeVisible();

		page.on('dialog', (d) => d.accept());
		await renamed.getByRole('button', { name: 'Delete' }).click();
		await expect(page.getByRole('row').filter({ hasText: name })).toHaveCount(0);
	});
}

test('alert channel: switching type back and forth keeps the form in step', async ({ page }) => {
	await signIn(page);
	await page.goto('/alerts');
	await page.getByRole('button', { name: 'Add channel', exact: true }).click();
	const dialog = page.getByRole('dialog');
	for (const ch of [...CHANNELS, ...CHANNELS.slice().reverse()]) {
		await dialog.locator('select').selectOption(ch.type);
		await expectOnlyFields(dialog, Object.keys(ch.fields));
	}
});

// Push has nothing to type: its subscription comes from the browser (#602). Here
// it cannot subscribe, so the form must explain why instead of hanging, and
// saving without a subscription must say what is missing.
test('alert channel: push swaps the fields for this device, and refuses to save unsubscribed', async ({
	page
}) => {
	await signIn(page);
	await page.goto('/alerts');
	await page.getByRole('button', { name: 'Add channel', exact: true }).click();
	const dialog = page.getByRole('dialog');
	await dialog.locator('select').selectOption('push');
	await expectOnlyFields(dialog, []);
	await expect(dialog.locator('.form-lbl').getByText('This device', { exact: true })).toBeVisible();
	// Headless Chromium denies notifications and this suite blocks workers, so
	// one of the explanations shows; never a button that cannot work.
	await expect(
		dialog.getByText(/blocked for nabz|background worker is not running|cannot receive push/)
	).toBeVisible({ timeout: 15_000 });
	await expect(dialog.getByRole('button', { name: /Turn on notifications/ })).toHaveCount(0);

	await dialog.getByRole('button', { name: 'Add Channel', exact: true }).click();
	await expect(
		dialog.getByText('Turn on notifications on this device first').first()
	).toBeVisible();
	await expect(dialog).toBeVisible();

	// And back: another type's fields return.
	await dialog.locator('select').selectOption('webhook');
	await expectOnlyFields(dialog, ['Webhook URL']);
});

test('alert channel: a second channel shows up without a reload', async ({ page }) => {
	// add() used to push into the array the list already held, so with one channel
	// on screen, the next one saved fine but never appeared until a refresh.
	await signIn(page);
	await page.goto('/alerts');
	const names = [`e2e-first-${RUN}`, `e2e-second-${RUN}`];
	for (const name of names) {
		await page
			.getByRole('button', { name: /add (your first )?channel/i })
			.first()
			.click();
		const dialog = page.getByRole('dialog');
		await dialog.getByPlaceholder('e.g. On-call Slack').fill(name);
		await dialog.getByLabel('Webhook URL').fill(`${FIXTURE}/echo`);
		await dialog.getByRole('button', { name: 'Add Channel', exact: true }).click();
		await expect(page.getByRole('row').filter({ hasText: name })).toBeVisible();
	}
	page.on('dialog', (d) => d.accept());
	for (const name of names) {
		await page
			.getByRole('row')
			.filter({ hasText: name })
			.getByRole('button', { name: 'Delete' })
			.click();
		await expect(page.getByRole('row').filter({ hasText: name })).toHaveCount(0);
	}
});

// The monitor form: the target field's label follows the type, the advanced
// section follows the type, and zones can be picked.
const MONITOR_TARGET_LABELS: Record<string, string> = {
	website: 'URL',
	port: 'Host:Port',
	ping: 'Host',
	dns: 'Hostname'
};

test('monitor form: the target field follows the type', async ({ page }) => {
	await signIn(page);
	await page.goto('/monitors/new');
	const type = page.locator('select.form-input').first();
	const label = (text: string) => page.locator('.form-lbl').getByText(text, { exact: true });
	for (const [t, text] of Object.entries(MONITOR_TARGET_LABELS)) {
		await type.selectOption(t);
		await expect(label(text)).toBeVisible();
	}
	await type.selectOption('heartbeat');
	await expect(label('Check-in URL')).toBeVisible();
	await expect(label('URL')).toHaveCount(0);
});

test('monitor: create with a zone and a non-default type, edit it, delete it', async ({ page }) => {
	await signIn(page);
	const name = `e2e-ui-port-monitor-${RUN}`;

	await page.goto('/monitors/new');
	await page.getByLabel('Name', { exact: true }).fill(name);
	await page.locator('select.form-input').first().selectOption('port');
	await page.getByLabel('Host:Port', { exact: true }).fill('fixture:9090');
	await page.getByLabel('Interval (seconds)').fill('30');
	const zones = page.locator('label').filter({ has: page.locator('input[type=checkbox]') });
	await expect(zones.first()).toBeVisible();
	await zones.first().locator('input[type=checkbox]').check();
	await expect(zones.first().locator('input[type=checkbox]')).toBeChecked();
	await page.getByRole('button', { name: 'Add monitor' }).click();

	await expect(page).toHaveURL(/\/monitors$/);
	const row = page.getByRole('row').filter({ hasText: name });
	await expect(row).toBeVisible();
	await expect(row).toContainText('fixture:9090');

	// Edit: the form opens on the saved type and target, and a rename sticks.
	await row.getByRole('button', { name: 'Edit' }).click();
	// An existing monitor's type is read-only, by design.
	await expect(page.getByLabel('Type', { exact: true })).toHaveValue('Port');
	await expect(page.getByLabel('Host:Port', { exact: true })).toHaveValue('fixture:9090');
	await page.getByLabel('Name', { exact: true }).fill(`${name}-renamed`);
	await page.getByRole('button', { name: /save/i }).click();
	await expect(page.getByText(`${name}-renamed`).first()).toBeVisible();

	await page.goto('/monitors');
	page.on('dialog', (d) => d.accept());
	const renamed = page.getByRole('row').filter({ hasText: `${name}-renamed` });
	await renamed.getByRole('button', { name: 'Delete' }).click();
	await expect(page.getByRole('row').filter({ hasText: name })).toHaveCount(0);
});

// Every page a signed-in user can reach renders without a runtime error.
const PAGES = [
	'/dashboard',
	'/monitors',
	'/monitors/new',
	'/monitors/map',
	'/monitors/dependencies',
	'/incidents',
	'/alerts',
	'/escalations',
	'/account',
	'/change-password',
	'/changelog'
];
for (const path of PAGES) {
	test(`page ${path} renders without errors`, async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
		await signIn(page);
		const res = await page.goto(path);
		expect(res?.status(), `${path} status`).toBeLessThan(400);
		await page.waitForLoadState('networkidle');
		expect(errors, `${path} errors`).toEqual([]);
	});
}
