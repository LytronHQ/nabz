import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { changelogVisible } from '$lib/server/changelog';

export const load: PageServerLoad = async ({ locals }) => {
	// Logged-in users go straight to the app; everyone else sees the landing page.
	if (locals.user) {
		throw redirect(303, '/dashboard');
	}
	return { changelogVisible };
};
