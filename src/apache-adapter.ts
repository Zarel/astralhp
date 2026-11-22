/**
 * Tells Astro what to build.
 */

import nodeAdapter from "@astrojs/node";
import type { AstroIntegration } from "astro";
import { fileURLToPath } from "node:url";

/** Keep Node's build-time image/session setup and render Apache requests with their public URL. */
export function apacheAdapter(mode: "apache-cgi" | "apache-proxy"): AstroIntegration {
	const integration = nodeAdapter({ mode: "middleware" });
	const name = `astralhp/${mode}`;
	const configure = integration.hooks["astro:config:done"]!;
	return {
		...integration,
		name,
		hooks: {
			...integration.hooks,
			"astro:config:done": context =>
				configure({
					...context,
					setAdapter(adapter) {
						const { previewEntrypoint: _previewEntrypoint, ...options } = adapter;
						context.setAdapter({
							...options,
							name,
							serverEntrypoint: fileURLToPath(new URL("./apache-app.js", import.meta.url)),
						});
					},
				}),
		},
	};
}
