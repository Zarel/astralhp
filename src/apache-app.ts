/**
 * The built Astro application shared by the Apache proxy and CGI runtimes.
 */

import { createApp } from "astro/app/entrypoint";
import { setGetEnv } from "astro/env/setup";

setGetEnv(key => process.env[key]);
export const app: ReturnType<typeof createApp> = createApp();

export function handler(request: Request, clientAddress?: string): Promise<Response> {
	return app.render(request, {
		addCookieHeader: true,
		...(clientAddress === undefined ? {} : { clientAddress }),
	});
}
