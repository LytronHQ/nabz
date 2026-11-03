import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import { competitorBySlug } from '#lib/compare.js';

export const load: PageLoad = ({ params }) => {
	const competitor = competitorBySlug(params.slug);
	if (!competitor) throw error(404, 'Not found');
	return { competitor };
};
