import type * as astro from "astro";
import fs from "node:fs";
import type * as vite from "vite";
import { contentType } from "./mime.js";
import type { Webroot } from "./webroot.js";

export interface DevServerOptions {
	port?: number;
}

export interface AstralHPDevServer {
	stop(): Promise<void>;
}

function isCompiledAssetRequest(pathname: string): boolean {
	return /\.(?:m?js|css)(?:\.map)?$/i.test(pathname) || /\/(?:_assets|_chunks)\//.test(pathname);
}

export function staticFiles(webroot: Webroot, endpoints: readonly RegExp[] = []): vite.Plugin {
	return {
		name: "astralhp:static-files",
		enforce: "pre",
		configureServer(server) {
			server.middlewares.use((request, response, next) => {
				const url = request.url ? URL.parse(request.url, "http://astralhp.local") : null;
				const pathname = url?.pathname ?? "";
				// Vite injects paths containing `node_modules` for its dev server dependencies.
				// We usually block them, so this bypasses that block.
				if (pathname.startsWith("/@fs/")) return next();
				// A prerendered endpoint can be stale. Let Astro run its current handler.
				const dist = isCompiledAssetRequest(pathname) && !endpoints.some(route => route.test(pathname));
				const lookup = webroot.lookup(url ?? undefined, { dist });
				if (lookup.kind === "private") {
					response.statusCode = 404;
					response.end();
					return;
				}
				if (request.method !== "GET" && request.method !== "HEAD") return next();
				const isTypeScript = /\.tsx?$/i.test(pathname);
				if (isTypeScript) {
					// Browsers accept HTML on navigation. Let Vite handle module imports.
					response.appendHeader("Vary", "Accept");
					if (!request.headers.accept?.includes("text/html")) return next();
				}
				if (lookup.kind !== "file") return next();
				const { filename } = lookup;

				response.statusCode = 200;
				response.setHeader("Content-Type", isTypeScript ? "text/plain; charset=utf-8" : contentType(filename));
				response.setHeader("Cache-Control", "no-cache");

				if (request.method === "HEAD") {
					response.end();
					return;
				}
				fs.createReadStream(filename).pipe(response);
			});
		},
	};
}

export async function startDev(
	webroot: Webroot,
	config: astro.AstroInlineConfig,
	options: DevServerOptions = {},
	endpoints: readonly RegExp[] = [],
): Promise<AstralHPDevServer> {
	process.env.ASTRO_TELEMETRY_DISABLED ||= "1";
	const { dev } = await import("astro");
	return dev({
		...config,
		server: {
			...config.server,
			...(options.port === undefined ? {} : { port: options.port }),
		},
		vite: {
			...config.vite,
			plugins: [
				...(config.vite?.plugins || []),
				staticFiles(webroot, endpoints),
			],
		},
	});
}
