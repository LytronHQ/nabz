import { get } from 'svelte/store';
import LoadingStore from '$lib/stores/loading-store';
import ErrorStore from '$lib/stores/error-store';

export default class BaseStore {
	loading = new LoadingStore();
	error = new ErrorStore();

	public subscribeLoading = this.loading.store.subscribe;
	public subscribeError = this.error.store.subscribe;

	/** The error from the most recent foreground fetch (null if it succeeded). */
	get lastError() {
		return get(this.error.store);
	}

	// `background: true` runs the request silently — no loading flag and no error
	// surface — so polling and post-action refreshes never flash an overlay or
	// pop an error on a transient blip. Only user-initiated foreground calls
	// touch the loading/error stores; the caller reads `lastError` to route the
	// failure (inline field errors vs. a toast).
	async fetch(url: string, init?: RequestInit, opts?: { background?: boolean }) {
		const background = opts?.background ?? false;
		if (background) {
			const response = await fetch(url, init);
			if (!response.ok) return undefined;
			return this.parseBody(response);
		}

		this.loading.start();
		const response = await fetch(url, init);
		this.loading.finish();

		const error = await this.error.fromResponseIfError(response);
		if (!error) {
			return this.parseBody(response);
		}
	}

	private parseBody(response: Response) {
		const contentType = response.headers.get('content-type');
		if (contentType && contentType.indexOf('application/json') !== -1) {
			return response.json();
		}
		return response.text();
	}
}
