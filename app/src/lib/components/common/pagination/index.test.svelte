<script lang="ts">
	import { PaginationData } from '#lib/models/index.js';
	import { Pagination } from '../';

	const customData = new PaginationData({
		current: 1,
		size: 10,
		totalItems: 100
	} as ConstructorParameters<typeof PaginationData>[0]);
</script>

<div data-testid="custom-data">
	<Pagination data={customData} />
</div>
