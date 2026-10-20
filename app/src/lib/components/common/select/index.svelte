<script lang="ts">
	// Token <select> (#168) — a native select styled by the app's `.form-input`,
	// replacing flowbite's <Select>. Same shape: `items` of { value, name } and a

	interface Props {
		// two-way `value` binding.
		items?: { value: unknown; name: string }[];
		value?: unknown;
		class?: string;
		/** Accessible name; the visible caption beside a select is a <span>, not a <label>. */
		label?: string;
	}

	let { items = [], value = $bindable(undefined), class: className = '', label }: Props = $props();
</script>

<select class="form-input {className}" aria-label={label} bind:value>
	{#each items as opt (opt.value)}
		<option value={opt.value}>{opt.name}</option>
	{/each}
</select>
