import { json, type RequestHandler } from '@sveltejs/kit';
import { DependencyItem, DependencyItemValidator, DependencyNewItem } from '$lib/models/dependency';
import { failIfNoResponse, failIfNoUser } from '$lib/utils/api-utils';
import { DefaultPageSize } from '$lib/constants';
import { getApiErrors } from '$lib/utils/action-utils';
import { wouldCycle } from '$lib/utils/dependency-graph';
import ApiError from '$lib/models/api-error';

function badRequest(message: string, field: string): Response {
	return json(new ApiError(false, message, 400, [{ field, message }]), { status: 400 });
}

export const GET: RequestHandler = async ({ locals, url }) => {
	failIfNoUser(locals);

	const pageNumber = url.searchParams.get('page') ? Number(url.searchParams.get('page')) : 1;
	const perPage = url.searchParams.get('perPage')
		? Number(url.searchParams.get('perPage'))
		: DefaultPageSize;

	try {
		const response = await locals.pb?.collection('dependencies').getList(pageNumber, perPage, {
			filter: `user="${locals.user?.id}"`,
			sort: '-created',
			expand: 'from,to'
		});

		const result = failIfNoResponse(response);
		return json({ ...result, items: result.items.map((item: any) => new DependencyItem(item)) });
	} catch (err) {
		return json(getApiErrors(err, 'Error getting dependencies'), { status: 500 });
	}
};

export const POST: RequestHandler = async ({ locals, request }) => {
	failIfNoUser(locals);

	const data = new DependencyNewItem(await request.json());
	const validation = new DependencyItemValidator(data);
	if (!validation.isValid) {
		return validation.getInvalidDataResponse();
	}

	try {
		// The existing edges for this user — needed to reject a duplicate and to
		// walk the graph for a cycle before creating.
		const existing = await locals.pb?.collection('dependencies').getFullList({
			filter: `user="${locals.user?.id}"`,
			fields: 'from,to'
		});
		const edges = (existing ?? []).map((r: any) => ({
			from: r.from as string,
			to: r.to as string
		}));

		if (edges.some((e) => e.from === data.from && e.to === data.to)) {
			return badRequest('That dependency already exists', 'to');
		}

		// A cycle would form iff `to` can already reach `from` following existing
		// edges (from -> to = "from depends on to"). Walk downstream from `to`.
		if (wouldCycle(edges, data.from, data.to)) {
			return badRequest('That would create a circular dependency', 'to');
		}

		const created = await locals.pb?.collection('dependencies').create({
			from: data.from,
			to: data.to,
			user: locals.user?.id
		});
		const record = failIfNoResponse(created);

		// Re-read with names so the client can render the new edge immediately.
		const expanded = await locals.pb?.collection('dependencies').getOne(record.id, {
			expand: 'from,to'
		});
		return json(new DependencyItem(expanded ?? record), { status: 201 });
	} catch (err) {
		return json(getApiErrors(err, 'Error creating dependency'), { status: 500 });
	}
};
