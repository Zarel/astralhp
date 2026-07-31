import type * as astro from "astro";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type * as vite from "vite";

const PRIVATE_DIRECTORIES = new Set([".caches", "node_modules"]);

export interface WebrootPaths {
	webroot: string;
	astroRoot: string;
	astro: string;
	vite: string;
	dist: string;
	nextDist: string;
	previousDist: string;
	public: string;
}

export interface AstrohpPage {
	pattern: string;
	entrypoint: string;
}

export interface AstrohpResolvedRoutes {
	routes: astro.IntegrationResolvedRoute[];
	trailingSlash: astro.AstroConfig["trailingSlash"];
}

export interface AstrohpConfigOptions {
	onRoutesResolved?: (resolved: AstrohpResolvedRoutes) => void;
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

export function isPrivateRequest(requestUrl: string | undefined): boolean {
	const parts = requestPathParts(requestUrl);
	return parts === null || hasPrivateDirectory(parts);
}

export function getWebrootPaths(root: string): WebrootPaths {
	const webroot = path.resolve(root);
	const astroRoot = path.join(webroot, ".caches");
	const astro = path.join(astroRoot, ".astro");

	return {
		webroot,
		astroRoot,
		astro,
		vite: path.join(astro, "vite"),
		dist: path.join(astroRoot, "dist"),
		nextDist: path.join(astroRoot, "next-dist"),
		previousDist: path.join(astroRoot, "previous-dist"),
		public: path.join(astro, "public"),
	};
}

export function scanAstroPages(root: string): AstrohpPage[] {
	const webroot = path.resolve(root);
	const pages: AstrohpPage[] = [];
	const patterns = new Map<string, string>();

	function scan(directory: string): void {
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			if (entry.name.startsWith(".")) continue;
			const filename = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				if (!PRIVATE_DIRECTORIES.has(entry.name.toLowerCase())) scan(filename);
				continue;
			}
			if (!entry.isFile() || !entry.name.endsWith(".astro")) continue;

			const relative = path.relative(webroot, filename);
			const segments = relative.split(path.sep);
			const basename = segments.pop()!.slice(0, -".astro".length);
			if (basename !== "index") segments.push(basename);
			const pattern = `/${segments.join("/")}`;
			const conflict = patterns.get(pattern);
			if (conflict) {
				throw new Error(
					`Astro pages ${conflict} and ${filename} both map to ${pattern}`,
				);
			}
			patterns.set(pattern, filename);
			pages.push({ pattern, entrypoint: filename });
		}
	}

	scan(webroot);
	return pages.sort((a, b) => a.pattern.localeCompare(b.pattern));
}

export function resolveWebrootFile(
	root: string,
	requestUrl: string | undefined,
): string | null {
	const parts = requestPathParts(requestUrl);
	if (
		parts === null || !parts.length || hasPrivateDirectory(parts) ||
		parts.some(part => part.startsWith("."))
	) {
		return null;
	}

	const filename = resolveContainedFile(path.resolve(root), parts);
	if (!filename) return null;
	const relativeFilename = path.relative(fs.realpathSync(root), filename);
	return hasPrivateDirectory(relativeFilename.split(path.sep)) ? null : filename;
}

export function resolveStaticFile(
	root: string,
	requestUrl: string | undefined,
): string | null {
	const filename = resolveWebrootFile(root, requestUrl);
	if (
		!filename ||
		[".astro", ".ts", ".tsx"].includes(path.extname(filename).toLowerCase())
	) {
		return null;
	}
	return filename;
}

function canonicalPath(filename: string): string {
	try {
		return fs.realpathSync.native(path.resolve(filename));
	} catch {
		return path.resolve(filename);
	}
}

export function resolveDistFile(
	distRoot: string,
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
		const filename = resolveContainedFile(path.resolve(distRoot), candidate);
		if (filename) return filename;
	}
	return null;
}

export function astrohpIntegration(
	pages: AstrohpPage[],
	options: AstrohpConfigOptions = {},
): astro.AstroIntegration {
	const entrypoints = new Set(
		pages.map(page => canonicalPath(page.entrypoint)),
	);
	let trailingSlash: astro.AstroConfig["trailingSlash"] = "ignore";

	return {
		name: "astrohp",
		hooks: {
			"astro:config:setup"({ injectRoute }) {
				for (const page of pages) injectRoute(page);
			},
			"astro:config:done"({ config }) {
				trailingSlash = config.trailingSlash;
			},
			"astro:routes:resolved"({ routes }) {
				if (!options.onRoutesResolved) return;
				options.onRoutesResolved({
					routes: routes.filter(route => entrypoints.has(canonicalPath(route.entrypoint))),
					trailingSlash,
				});
			},
		},
	};
}

function outsideRootEntrypoints(
	paths: WebrootPaths,
	pages: AstrohpPage[],
): vite.Plugin {
	const compilerRuntime = fileURLToPath(
		import.meta.resolve("astro/compiler-runtime"),
	);
	const components = fileURLToPath(import.meta.resolve("astrohp/components"));
	const entrypoints = new Map(
		pages.map(page => {
			const relative = path
				.relative(paths.astroRoot, page.entrypoint)
				.split(path.sep)
				.join("/");
			return [`/${relative}`, page.entrypoint];
		}),
	);

	return {
		name: "astrohp:outside-root-entrypoints",
		enforce: "pre",
		resolveId(source) {
			if (source === "astro/compiler-runtime") return compilerRuntime;
			if (source === "astrohp/components") return components;
			return entrypoints.get(source) ?? null;
		},
	};
}

export function astroConfig(
	root: string,
	options: AstrohpConfigOptions = {},
): astro.AstroInlineConfig {
	const paths = getWebrootPaths(root);
	const pages = scanAstroPages(paths.webroot);
	if (!pages.length) {
		throw new Error(`No .astro pages found in ${paths.webroot}`);
	}

	return {
		root: paths.astroRoot,
		cacheDir: paths.astro,
		publicDir: paths.public,
		devToolbar: {
			enabled: false,
		},
		integrations: [astrohpIntegration(pages, options)],
		vite: {
			root: paths.webroot,
			cacheDir: paths.vite,
			server: {
				watch: {
					ignored: ["**/.caches/**"],
				},
			},
			define: {
				"import.meta.env.ASTROHP_WEBROOT": JSON.stringify(paths.webroot),
			},
			plugins: [outsideRootEntrypoints(paths, pages)],
		},
	};
}
