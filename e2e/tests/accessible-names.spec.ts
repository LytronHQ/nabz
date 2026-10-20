import { test, expect } from '@playwright/test';
import { signIn } from './helpers';

// Controls a screen reader announced with no name: the monitor form's selects
// (their caption was a sibling <span>, not a label), the channel form's Type,
// and three inputs that had only a placeholder — which also vanishes from the
// tag input once it holds a tag.

test('monitor form: every select and the tag input have a name', async ({ page }) => {
	await signIn(page);
	await page.goto('/monitors/new');
	await expect(page.getByRole('combobox', { name: 'Type' })).toBeVisible();
	await expect(page.getByRole('combobox', { name: 'Escalation policy' })).toBeVisible();
	await expect(page.getByRole('textbox', { name: 'Tags' })).toBeVisible();
	await page.getByText('Advanced options').click();
	await expect(page.getByRole('combobox', { name: 'Method' })).toBeVisible();
	await expect(page.getByRole('combobox', { name: 'Response body check' })).toBeVisible();
	// Advanced options stays open across a type change.
	await page.getByRole('combobox', { name: 'Type' }).selectOption('dns');
	await expect(page.getByRole('combobox', { name: 'Record type' })).toBeVisible();
});

test('monitor search, channel type and incident comment have names', async ({ page }) => {
	await signIn(page);
	await page.goto('/monitors');
	await expect(page.getByRole('searchbox', { name: 'Search monitors' })).toBeVisible();

	await page.goto('/alerts');
	await page
		.getByRole('button', { name: /add (your first )?channel/i })
		.first()
		.click();
	await expect(page.getByRole('dialog').getByRole('combobox', { name: 'Type' })).toBeVisible();
	await page.keyboard.press('Escape');

	await page.goto('/incidents');
	await page.locator('a[href^="/incidents/"]').first().click();
	await expect(page.getByRole('textbox', { name: 'Comment' })).toBeVisible();
});

// Filter and range toggles showed which one is active only by colour.
test('toggle buttons say which one is pressed', async ({ page }) => {
	await signIn(page);
	await page.goto('/monitors');
	const filters = page.locator('.mon-status');
	await expect(filters.getByRole('button', { name: 'All' })).toHaveAttribute(
		'aria-pressed',
		'true'
	);
	await filters.getByRole('button', { name: 'down', exact: true }).click();
	await expect(filters.getByRole('button', { name: 'down', exact: true })).toHaveAttribute(
		'aria-pressed',
		'true'
	);
	await expect(filters.getByRole('button', { name: 'All' })).toHaveAttribute(
		'aria-pressed',
		'false'
	);

	await page.goto('/incidents');
	await page.getByRole('button', { name: 'Open', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Open', exact: true })).toHaveAttribute(
		'aria-pressed',
		'true'
	);
});
