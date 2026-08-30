import { writable } from 'svelte/store';

export default class LoadingStore {
	public store = writable(false);

	start() {
		this.store.set(true);
	}

	finish() {
		this.store.set(false);
	}
}
