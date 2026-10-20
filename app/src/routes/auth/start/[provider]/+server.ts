import type { RequestHandler } from './$types';
import { startOAuth } from '#lib/server/oauth-start.js';

// Sign in (or up) with a provider.
export const GET: RequestHandler = (event) => startOAuth(event, false);
