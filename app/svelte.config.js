import adapterNode from '@sveltejs/adapter-node';
import adapterCloudflare from '@sveltejs/adapter-cloudflare';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

// Pick the adapter by ADAPTER env:
//   cloudflare — production: Cloudflare Workers with static assets (wrangler.toml).
//   node       — a standalone Node server (`node build`) for self-hosting on a VM
//                (deploy/web.yml, used on dev VMs).
//   (unset)    — node, so a local/CI build "just works". Was adapter-auto, which
//                on the Cloudflare path only ever printed "could not detect a
//                supported production environment" and produced nothing usable.
function pickAdapter() {
	switch (process.env.ADAPTER) {
		case 'cloudflare':
			return adapterCloudflare();
		case 'node':
			return adapterNode();
		default:
			return adapterNode();
	}
}

/** @type {import('@sveltejs/kit').Config} */
const config = {
	// Consult https://kit.svelte.dev/docs/integrations#preprocessors
	// for more information about preprocessors
	preprocess: vitePreprocess(),

	kit: {
		adapter: pickAdapter()
	}
};

export default config;
