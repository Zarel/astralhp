import type { AstroInlineConfig, AstroIntegration } from "astro";
import fs from "node:fs";
import path from "node:path";
import type * as vite from "vite";

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

export interface WebrootPaths {
	webroot: string;
	astroRoot: string;
	astro: string;
	vite: string;
	build: string;
	public: string;
	index: string;
}

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

function hasPrivateDirectory(parts: string[]): boolean {
	return parts.some(part => PRIVATE_DIRECTORIES.has(part.toLowerCase()));
}

function resolveContainedFile(root: string, parts: string[]): string | null {
	const filename = path.resolve(root, ...parts);
	const relativeFilename = path.relative(root, filename);
	if (
		relativeFilename === ".." ||
		relativeFilename.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relativeFilename)
	) {
		return null;
	}

	try {
		if (!fs.statSync(filename).isFile()) return null;

		const realRoot = fs.realpathSync(root);
		const realFilename = fs.realpathSync(filename);
		const realRelativeFilename = path.relative(realRoot, realFilename);
		if (
			realRelativeFilename === ".." ||
			realRelativeFilename.startsWith(`..${path.sep}`) ||
			path.isAbsolute(realRelativeFilename)
		) {
			return null;
		}
		return realFilename;
	} catch {
		return null;
	}
}

export function contentType(filename: string): string {
	return (
		MIME_TYPES[path.extname(filename).toLowerCase()] || "application/octet-stream"
	);
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

export function getWebrootPaths(root: string): WebrootPaths {
	const webroot = path.resolve(root);
	const packageRoot = findPackageRoot(webroot);
	const cacheRoot = packageRoot || webroot;
	const relativeRoot = packageRoot ? path.relative(packageRoot, webroot) : "";
	const webrootCache = path.join(cacheRoot, "caches", relativeRoot || "_root");
	const astro = path.join(webrootCache, ".astro");

	return {
		webroot,
		astroRoot: webrootCache,
		astro,
		vite: path.join(astro, "vite"),
		build: path.join(webrootCache, "build"),
		public: path.join(astro, "public"),
		index: path.join(webroot, "index.astro"),
	};
}

export function resolveStaticFile(
	root: string,
	requestUrl: string | undefined,
): string | null {
	const parts = requestPathParts(requestUrl);
	if (
		parts === null || !parts.length || hasPrivateDirectory(parts) ||
		parts.some(part => part.startsWith(".")) ||
		path.extname(parts.at(-1)!).toLowerCase() === ".astro"
	) {
		return null;
	}

	const filename = resolveContainedFile(path.resolve(root), parts);
	if (!filename) return null;
	const relativeFilename = path.relative(fs.realpathSync(root), filename);
	return hasPrivateDirectory(relativeFilename.split(path.sep)) ? null : filename;
}

export function resolveBuiltFile(
	buildRoot: string,
	requestUrl: string | undefined,
): string | null {
	const parts = requestPathParts(requestUrl);
	if (parts === null || hasPrivateDirectory(parts)) return null;

	const candidates = !parts.length ?
		[["index.html"]] :
		path.extname(parts.at(-1)!) ?
		[parts] :
		[
			[...parts.slice(0, -1), `${parts.at(-1)}.html`],
			[...parts, "index.html"],
		];

	for (const candidate of candidates) {
		const filename = resolveContainedFile(path.resolve(buildRoot), candidate);
		if (filename) return filename;
	}
	return null;
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

function outsideRootEntrypoint(paths: WebrootPaths): vite.Plugin {
	const relativeEntrypoint = path
		.relative(paths.astroRoot, paths.index)
		.split(path.sep)
		.join("/");
	const buildImport = `/${relativeEntrypoint}`;

	return {
		name: "astrohp:outside-root-entrypoint",
		enforce: "pre",
		resolveId(source) {
			return source === buildImport ? paths.index : null;
		},
	};
}

export function astroConfig(root: string): AstroInlineConfig {
	const paths = getWebrootPaths(root);
	if (!fs.existsSync(paths.index)) {
		throw new Error(`No index.astro found in ${paths.webroot}`);
	}

	return {
		root: paths.astroRoot,
		cacheDir: paths.astro,
		publicDir: paths.public,
		devToolbar: {
			enabled: false,
		},
		integrations: [astrohpIntegration(paths.index)],
		vite: {
			root: paths.webroot,
			cacheDir: paths.vite,
			define: {
				"import.meta.env.ASTROHP_WEBROOT": JSON.stringify(paths.webroot),
			},
			plugins: [outsideRootEntrypoint(paths)],
		},
	};
}
