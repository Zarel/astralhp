import fs from "node:fs";
import type * as vite from "vite";
import { astroConfig, contentType, getWebrootPaths, isPrivateRequest, resolveStaticFile } from "./webroot.ts";

export function staticFiles(root: string): vite.Plugin {
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

				const filename = resolveStaticFile(root, request.url);
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
	const config = astroConfig(root);
	const { dev } = await import("astro");
	return dev({
		...config,
		vite: {
			...config.vite,
			plugins: [...(config.vite?.plugins || []), staticFiles(paths.webroot)],
		},
	});
}

export {
	astrohpIntegration,
	findPackageRoot,
	getWebrootPaths,
	isPrivateRequest,
	resolveStaticFile,
} from "./webroot.ts";
