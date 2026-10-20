import type { RequestHandler } from './$types';
import { startOAuth } from '#lib/server/oauth-start.js';

// Connect a provider to the signed-in account, from /account (#622).
export const GET: RequestHandler = (event) => startOAuth(event, true);
