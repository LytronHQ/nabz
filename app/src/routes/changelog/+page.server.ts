import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { changelogEntries, changelogVisible } from '$lib/server/changelog';

export const load: PageServerLoad = async () => {
	// Hidden until the 3-entry threshold is met.
	if (!changelogVisible) {
		throw error(404, 'Not found');
	}
	return { entries: changelogEntries };
};
