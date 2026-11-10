import type * as astro from "astro";
import fs from "node:fs";
import type * as vite from "vite";
import { babelWatcher, compileScripts } from "./babel.js";
import { contentType } from "./mime.js";
import type { Webroot } from "./webroot.js";

export interface DevServerOptions {
	port?: number;
}

export interface AstroHPDevServer {
	stop(): Promise<void>;
}

function isCompiledScriptRequest(requestUrl: string | undefined): boolean {
	if (!requestUrl) return false;
	try {
		return /\.js(?:\.map)?$/i.test(
			new URL(requestUrl, "http://astrohp.local").pathname,
		);
	} catch {
		return false;
	}
}

export function staticFiles(webroot: Webroot): vite.Plugin {
	return {
		name: "astrohp:static-files",
		enforce: "pre",
		configureServer(server) {
			server.middlewares.use((request, response, next) => {
				if (webroot.isPrivateRequest(request.url)) {
					response.statusCode = 404;
					response.end();
					return;
				}
				if (request.method !== "GET" && request.method !== "HEAD") return next();
				// resolveStaticFile excludes TypeScript sources. Let Vite transform
				// module imports of those files instead of serving them verbatim.
				const filename = (
					isCompiledScriptRequest(request.url) &&
					webroot.resolveDistFile(request.url)
				) || webroot.resolveStaticFile(request.url);
				if (!filename) return next();

				response.statusCode = 200;
				response.setHeader("Content-Type", contentType(filename));
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
): Promise<AstroHPDevServer> {
	process.env.ASTRO_TELEMETRY_DISABLED ||= "1";
	await compileScripts(webroot);
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
				babelWatcher(webroot),
				staticFiles(webroot),
			],
		},
	});
}
