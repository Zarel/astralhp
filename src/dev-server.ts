import fs from "node:fs";
import type * as vite from "vite";
import { babelWatcher, compileScripts } from "./babel.ts";
import { contentType } from "./mime.ts";
import { astroConfig, getWebrootPaths, isPrivateRequest, resolveStaticFile } from "./webroot.ts";

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

function isSourceRequest(requestUrl: string | undefined): boolean {
	if (!requestUrl) return false;
	try {
		return /\.tsx?$/i.test(
			new URL(requestUrl, "http://astrohp.local").pathname,
		);
	} catch {
		return false;
	}
}

export function staticFiles(
	paths: ReturnType<typeof getWebrootPaths>,
): vite.Plugin {
	return {
		name: "astrohp:static-files",
		enforce: "pre",
		configureServer(server) {
			server.middlewares.use((request, response, next) => {
				if (isPrivateRequest(request.url)) {
					response.statusCode = 404;
					response.end();
					return;
				}
				if (request.method !== "GET" && request.method !== "HEAD") return next();
				if (isSourceRequest(request.url)) {
					response.statusCode = 404;
					response.end();
					return;
				}

				const filename = (
					isCompiledScriptRequest(request.url) &&
					resolveStaticFile(paths.dist, request.url)
				) || resolveStaticFile(paths.webroot, request.url);
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

export async function startDev(root = process.cwd()) {
	process.env.ASTRO_TELEMETRY_DISABLED ||= "1";
	const paths = getWebrootPaths(root);
	await compileScripts(paths);
	const config = astroConfig(root);
	const { dev } = await import("astro");
	return dev({
		...config,
		vite: {
			...config.vite,
			plugins: [
				...(config.vite?.plugins || []),
				babelWatcher(paths),
				staticFiles(paths),
			],
		},
	});
}

export { astrohpIntegration, getWebrootPaths, isPrivateRequest, resolveStaticFile } from "./webroot.ts";
