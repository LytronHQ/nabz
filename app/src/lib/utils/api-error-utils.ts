import type ApiError from '$lib/models/api-error';

/**
 * A 400 carries per-field validation errors we can show inline on the form.
 * Returns a { fieldName: message } map, keyed lowercase so it matches the
 * form's field names regardless of how the API cased them.
 */
export function fieldErrorsFrom(err: ApiError | null | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	for (const e of err?.errors ?? []) {
		if (e?.field) out[e.field.toLowerCase()] = e.message;
	}
	return out;
}

/** True when the error is field-level validation we should render inline. */
export function isValidationError(err: ApiError | null | undefined): boolean {
	return err?.status === 400 && (err?.errors?.length ?? 0) > 0;
}

/**
 * A human-readable message for a system-level error (anything that isn't inline
 * field validation), mapping the common raw/opaque cases to plain language.
 */
export function friendlyMessage(err: ApiError | null | undefined): string {
	const status = err?.status;
	if (!status || status === 0)
		return "Couldn't reach the server. Check your connection and try again.";
	if (status === 401 || status === 403) return 'You are not allowed to do that.';
	if (status === 404) return "That item couldn't be found — it may have been deleted.";
	if (status === 429) return 'Too many requests — please wait a moment and try again.';
	if (status >= 500) return 'Something went wrong on our side. Please try again.';
	return err?.message || 'Something went wrong. Please try again.';
}
