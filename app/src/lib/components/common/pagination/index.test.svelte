<script lang="ts">
	import { PaginationData } from '$lib/models';
	import { Pagination } from '../';

	const customData = new PaginationData({
		current: 1,
		size: 10,
		totalItems: 100
	} as any);
</script>

<div data-testid="custom-data">
	<Pagination data={customData} />
</div>
