import type ApiError from '$lib/models/api-error';
import { pushToast } from '$lib/stores/toast-store';
import { fieldErrorsFrom, isValidationError, friendlyMessage } from '$lib/utils/api-error-utils';

/**
 * Route a failed save (#167): a 400 validation error becomes inline field errors
 * (returned as a `{ field: message }` map to bind to the form); anything else
 * surfaces as an error toast and returns an empty map. One place for what was the
 * copy-pasted `routeSaveError` / inlined field-vs-toast branch across the forms.
 */
export function routeSaveError(error: ApiError | null): Record<string, string> {
	if (isValidationError(error)) return fieldErrorsFrom(error);
	pushToast('error', friendlyMessage(error));
	return {};
}
