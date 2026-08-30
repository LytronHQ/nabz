<script lang="ts">
	// Token <select> (#168) — a native select styled by the app's `.form-input`,
	// replacing flowbite's <Select>. Same shape: `items` of { value, name } and a

	interface Props {
		// two-way `value` binding.
		items?: { value: unknown; name: string }[];
		value?: unknown;
		class?: string;
	}

	let { items = [], value = $bindable(undefined), class: className = '' }: Props = $props();
</script>

<select class="form-input {className}" bind:value>
	{#each items as opt (opt.value)}
		<option value={opt.value}>{opt.name}</option>
	{/each}
</select>
