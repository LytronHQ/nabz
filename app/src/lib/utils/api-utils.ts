import type { EntityIdType } from '$lib/constants';
import { fail } from '@sveltejs/kit';

export function failIfNoUser(locals: App.Locals) {
	if (!locals.user) {
		throw fail(401);
	}
}

export function failIfNoId(id: EntityIdType): string {
	if (!id) {
		throw fail(400);
	}

	return id;
}

export function failIfNoResponse(response: any | undefined): any {
	if (!response) {
		throw fail(404);
	}

	return response;
}
