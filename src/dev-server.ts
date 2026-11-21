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
				if (webroot.isPrivateRequest(request.url)) {
					response.statusCode = 404;
					response.end();
					return;
				}
				if (request.method !== "GET" && request.method !== "HEAD") return next();
				const pathname = new URL(request.url!, "http://astralhp.local").pathname;
				const isTypeScript = /\.tsx?$/i.test(pathname);
				if (isTypeScript) {
					// Browsers accept HTML on navigation. Let Vite handle module imports.
					response.appendHeader("Vary", "Accept");
					if (!request.headers.accept?.includes("text/html")) return next();
				}
				// A .js or .css endpoint may have a stale prerendered file in dist.
				// Let Astro run its current handler in development.
				const compiled = isCompiledAssetRequest(pathname) && !endpoints.some(route => route.test(pathname));
				const filename = (compiled && webroot.resolveDistFile(request.url)) || webroot.resolveStaticFile(request.url);
				if (!filename) return next();

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
