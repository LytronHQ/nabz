import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import { toolById } from '#lib/tools/tools.js';

export const load: PageLoad = ({ params }) => {
	const tool = toolById(params.tool);
	if (!tool) throw error(404, 'Not found');
	return { tool };
};
