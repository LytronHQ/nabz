import { writable } from 'svelte/store';
import ApiError from '../models/api-error';

export default class ErrorStore {
	// Starts null, not {}. An empty object is truthy but has no message, which
	// used to trip "is there an error?" checks and render a blank error surface.
	public store = writable(null as ApiError | null);

	async fromResponseIfError(response: Response): Promise<boolean> {
		this.clear();

		if (!response.ok) {
			const fallback = `Request failed (${response.status} ${response.statusText})`;

			let parsed: Partial<ApiError> | null = null;
			try {
				parsed = (await response.json()) as Partial<ApiError>;
			} catch {
				// no body / not JSON — fall back below
			}

			// Always stamp the real HTTP status. Response bodies don't reliably
			// carry `status` (a 400 validation body is just { message, errors }),
			// so trusting the body would leave status undefined and misroute the
			// error (validation shown as a toast instead of inline on the field).
			this.set({
				success: false,
				status: response.status,
				message: parsed?.message || fallback,
				errors: parsed?.errors
			} as ApiError);

			return true;
		}

		return false;
	}

	set(error: ApiError) {
		this.store.set(error);
	}

	clear() {
		this.store.set(null);
	}
}
