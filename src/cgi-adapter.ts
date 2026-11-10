/**
 * Tells Astro what to build.
 */

import nodeAdapter from "@astrojs/node";
import type { AstroIntegration } from "astro";
import { fileURLToPath } from "node:url";

/** Keep Node's build-time image/session setup, but render directly with the selected JavaScript interpreter. */
export function cgiAdapter(): AstroIntegration {
	const integration = nodeAdapter({ mode: "middleware" });
	const configure = integration.hooks["astro:config:done"]!;
	return {
		...integration,
		name: "astrohp/apache-cgi",
		hooks: {
			...integration.hooks,
			"astro:config:done": context =>
				configure({
					...context,
					setAdapter(adapter) {
						const { previewEntrypoint, ...options } = adapter;
						context.setAdapter({
							...options,
							name: "astrohp/apache-cgi",
							serverEntrypoint: fileURLToPath(new URL("./cgi-entry.js", import.meta.url)),
						});
					},
				}),
		},
	};
}
