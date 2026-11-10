/**
 * Sends a request to Astro.
 */

import { createApp } from "astro/app/entrypoint";
import { setGetEnv } from "astro/env/setup";

setGetEnv(key => process.env[key]);
const app = createApp();

export function handler(request: Request, clientAddress?: string): Promise<Response> {
	return app.render(request, {
		addCookieHeader: true,
		...(clientAddress === undefined ? {} : { clientAddress }),
	});
}
