// See https://kit.svelte.dev/docs/types#app
// for information about these interfaces
declare global {
	namespace App {
		// interface Error {}

		type PocketBase = import('pocketbase').default;
		interface Locals {
			pb?: PocketBase;
			user?: PocketBase['authStore']['record'];
			// Opaque anonymous "try it" session token (#269); '' when signed out and no trial started.
			anonSession?: string;
			getPocketBaseFileUrl: (record: any, fileName: any) => string | undefined;
		}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
