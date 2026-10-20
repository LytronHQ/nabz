import { fail, type ActionFailure } from '@sveltejs/kit';
import * as ChangeCase from 'change-case';
import type { z } from 'zod';
import type ApiError from '#lib/models/api-error.js';

type ActionOutputType = {
	success: boolean;
	message: string;
	errors?: Array<{ field: string; message: string }>;
};

// What callers hand these helpers: a PocketBase ClientResponseError from a
// catch block (field errors under `data.data`), or a literal `{ status: 400 }`.
type PocketBaseErrorLike = {
	status: number;
	data?: { data?: Record<string, { message: string; code: string }> };
};

export function getActionFailure(err: unknown, message: string): ActionFailure<ActionOutputType> {
	const errors = getPocketBaseErrors(err);
	// SvelteKit 3 answers an enhanced action with this status. A PocketBase error
	// without an HTTP one (status 0: PocketBase unreachable) made it throw on
	// `Response.json(..., { status: 0 })`, turning the form's message into a 500.
	const status = (err as PocketBaseErrorLike).status;
	const valid = typeof status === 'number' && status >= 400 && status <= 599;
	return fail(valid ? status : 503, {
		success: false,
		message,
		errors
	} as ActionOutputType);
}

export function getApiErrors(err: unknown, message: string) {
	const errors = getPocketBaseErrors(err);
	return {
		success: false,
		status: (err as PocketBaseErrorLike).status,
		message,
		errors
	} as ApiError;
}

function getPocketBaseErrors(err: unknown) {
	const fields = (err as PocketBaseErrorLike | null | undefined)?.data?.data;
	if (fields) {
		return Object.keys(fields).map((key) => ({
			field: ChangeCase.capitalCase(key),
			message: fields[key].message,
			code: fields[key].code
		}));
	}

	return undefined;
}

// Generic over the schema so callers get the parsed shape back. zod 4 removed
// ZodTypeAny; typing the parameter as the old alias erased the return type to
// `{}`, so every `const { email } = await getFormRecord(...)` stopped compiling.
export async function getFormRecord<T extends z.ZodType>(
	request: Request,
	schema: T
): Promise<z.infer<T> | null> {
	const formData = await request.formData();
	const data = Object.fromEntries(formData);
	const parsed = schema.safeParse(data);

	if (!parsed.success) {
		return null;
	}

	return parsed.data;
}

// Only the provider names go to the page. Its state, PKCE verifier and the key
// that seals them stay on the server: /auth/start/[provider] sets the cookie.
// This used to return PKCE_FLOW_ENCRYPTION_KEY so the browser could encrypt the
// cookie itself, which published the key in every /signin and /signup (#580).
//
// Providers are optional, so a PocketBase that cannot be reached means "none":
// throwing here turned an outage into a 500 page in place of the sign-in form,
// whose own action already reports the outage (#582).
export async function getAuthCallbackData(locals: App.Locals) {
	const authMethods = await locals.pb
		?.collection('users')
		.listAuthMethods()
		.catch((err) => {
			console.error('listAuthMethods failed; showing no OAuth providers', err);
			return undefined;
		});
	if (!authMethods?.oauth2?.providers) {
		return {};
	}
	return { providers: authMethods.oauth2.providers.map((provider) => ({ name: provider.name })) };
}
