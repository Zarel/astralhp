import type { AstroIntegration } from "astro";
import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

const MIME_TYPES: Readonly<Record<string, string>> = {
	".css": "text/css; charset=utf-8",
	".gif": "image/gif",
	".html": "text/html; charset=utf-8",
	".ico": "image/x-icon",
	".jpeg": "image/jpeg",
	".jpg": "image/jpeg",
	".js": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".png": "image/png",
	".svg": "image/svg+xml",
	".txt": "text/plain; charset=utf-8",
	".webp": "image/webp",
};

const PRIVATE_DIRECTORIES = new Set(["caches", "node_modules"]);

function requestPathParts(requestUrl: string | undefined): string[] | null {
	if (!requestUrl) return null;
	try {
		const pathname = decodeURIComponent(
			new URL(requestUrl, "http://astrohp.local").pathname,
		);
		return pathname.split("/").filter(Boolean);
	} catch {
		return null;
	}
}

function hasPrivateDirectory(parts: string[]) {
	return parts.some(part => PRIVATE_DIRECTORIES.has(part.toLowerCase()));
}

export function isPrivateRequest(requestUrl: string | undefined): boolean {
	const parts = requestPathParts(requestUrl);
	return parts === null || hasPrivateDirectory(parts);
}

export function findPackageRoot(root: string): string | null {
	let current = path.resolve(root);
	while (true) {
		try {
			if (fs.statSync(path.join(current, "package.json")).isFile()) return current;
		} catch {}

		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

export function getCacheDirs(root: string) {
	root = path.resolve(root);
	const packageRoot = findPackageRoot(root);
	const cacheRoot = packageRoot || root;
	const relativeRoot = packageRoot ? path.relative(packageRoot, root) : "";
	const webrootCache = path.join(cacheRoot, "caches", relativeRoot || "_root");

	return {
		astro: path.join(webrootCache, "astro"),
		vite: path.join(webrootCache, "vite"),
	};
}

export function resolveStaticFile(
	root: string,
	requestUrl: string | undefined,
): string | null {
	root = path.resolve(root);
	const parts = requestPathParts(requestUrl);
	if (
		parts === null ||
		!parts.length ||
		hasPrivateDirectory(parts) ||
		parts.some(part => part.startsWith(".")) ||
		path.extname(parts.at(-1)!).toLowerCase() === ".astro"
	) {
		return null;
	}

	const filename = path.resolve(root, ...parts);

	try {
		if (!fs.statSync(filename).isFile()) return null;

		const realRoot = fs.realpathSync(root);
		const realFilename = fs.realpathSync(filename);
		const relativeFilename = path.relative(realRoot, realFilename);
		const realParts = relativeFilename.split(path.sep);
		if (
			relativeFilename === ".." ||
			relativeFilename.startsWith(`..${path.sep}`) ||
			path.isAbsolute(relativeFilename) ||
			hasPrivateDirectory(realParts)
		) {
			return null;
		}
		return realFilename;
	} catch {
		return null;
	}
}

export function staticFiles(root: string): Plugin {
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
				response.setHeader(
					"Content-Type",
					MIME_TYPES[path.extname(filename).toLowerCase()] || "application/octet-stream",
				);
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

export function astrohpIntegration(indexFile: string): AstroIntegration {
	return {
		name: "astrohp",
		hooks: {
			"astro:config:setup"({ injectRoute }) {
				injectRoute({
					pattern: "/",
					entrypoint: indexFile,
				});
			},
		},
	};
}

export async function startDev(root = process.cwd()) {
	root = path.resolve(root);
	const indexFile = path.join(root, "index.astro");
	if (!fs.existsSync(indexFile)) {
		throw new Error(`No index.astro found in ${root}`);
	}

	process.env.ASTRO_TELEMETRY_DISABLED ||= "1";
	const cacheDirs = getCacheDirs(root);
	const { dev } = await import("astro");
	return dev({
		root: cacheDirs.astro,
		cacheDir: cacheDirs.astro,
		devToolbar: {
			enabled: false,
		},
		integrations: [astrohpIntegration(indexFile)],
		vite: {
			root,
			cacheDir: cacheDirs.vite,
			plugins: [staticFiles(root)],
		},
	});
}
