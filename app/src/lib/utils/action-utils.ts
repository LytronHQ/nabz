import { fail, type ActionFailure } from '@sveltejs/kit';
import * as ChangeCase from 'change-case';
import type { z } from 'zod';
import { env } from '$env/dynamic/private';
import type { AuthProviderCallbackData } from './auth-cookie-utils';
import type ApiError from '$lib/models/api-error';

type ActionOutputType = {
	success: boolean;
	message: string;
	errors?: Array<{ field: string; message: string }>;
};

export function getActionFailure(err: any, message: string): ActionFailure<ActionOutputType> {
	const errors = getPocketBaseErrors(err);
	return fail(err.status, {
		success: false,
		message,
		errors
	} as ActionOutputType);
}

export function getApiErrors(err: any, message: string) {
	const errors = getPocketBaseErrors(err);
	return {
		success: false,
		status: err.status,
		message,
		errors
	} as ApiError;
}

function getPocketBaseErrors(err: any) {
	if (err?.data?.data) {
		return Object.keys(err.data.data).map((key) => ({
			field: ChangeCase.capitalCase(key),
			message: err.data.data[key].message,
			code: err.data.data[key].code
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

export async function getAuthCallbackData(locals: App.Locals, url: URL) {
	const callbackRedirectURL = `${url.origin}/auth/callback`;
	const authMethods = await locals.pb?.collection('users').listAuthMethods();
	if (!authMethods?.oauth2?.providers) {
		return {};
	}

	return {
		providers: authMethods.oauth2.providers.map(
			(provider) =>
				({
					name: provider.name,
					state: provider.state,
					codeVerifier: provider.codeVerifier,
					redirectUrl: `${provider.authURL}${callbackRedirectURL}`
				}) as AuthProviderCallbackData
		),
		key: env.PKCE_FLOW_ENCRYPTION_KEY
	};
}
