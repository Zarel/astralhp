import type * as astro from "astro";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Adapter, WebrootConfig } from "./config.d.ts";

import {
	type LoadedWebrootConfig,
	requireConfig,
	requireConfigs,
	resolveConfig,
	searchConfigs,
	validateConfig,
} from "./config-loader.js";

export { validateConfig } from "./config-loader.js";

const PRIVATE_DIRECTORIES = new Set([".caches", ".server", "node_modules"]);

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
	entrypointRoot?: string;
	staticOnly?: boolean;
	prerender?: boolean;
}

function canonicalPath(filename: string): string {
	try {
		return fs.realpathSync.native(path.resolve(filename));
	} catch {
		return path.resolve(filename);
	}
}

export function astrohpIntegration(
	pages: AstrohpPage[],
	options: AstrohpConfigOptions = {},
): astro.AstroIntegration {
	const entrypoints = new Set(
		pages.map(page => canonicalPath(page.entrypoint)),
	);
	let trailingSlash: astro.AstroConfig["trailingSlash"] = "ignore";
	const canonicalEntrypoint = (entrypoint: string): string =>
		canonicalPath(
			path.isAbsolute(entrypoint) ?
				entrypoint :
				path.resolve(options.entrypointRoot ?? "", entrypoint),
		);

	return {
		name: "astrohp",
		hooks: {
			"astro:config:setup"({ injectRoute }) {
				// Set page defaults independently of the adapter's output mode.
				// Astro still gives an explicit page export precedence over this.
				for (const page of pages) injectRoute({ ...page, prerender: options.prerender ?? true });
			},
			"astro:config:done"({ config }) {
				trailingSlash = config.trailingSlash;
			},
			"astro:routes:resolved"({ routes }) {
				if (options.staticOnly) {
					// Astro adds internal image, server-island, and fallback routes
					// during dev and sync even for fully static sites.
					const dynamic = routes.filter(route =>
						route.origin !== "internal" && !route.isPrerendered &&
						(route.type === "page" || route.type === "endpoint")
					);
					if (dynamic.length) {
						throw new Error(
							`apache-static does not support dynamic routes:\n${dynamic.map(route => route.entrypoint).join("\n")}\n` +
							"Set prerender = true on these pages or in astrohp.mts, or choose an adapter that supports dynamic routes.",
						);
					}
				}
				if (!options.onRoutesResolved) return;
				options.onRoutesResolved({
					routes: routes.filter(route => entrypoints.has(canonicalEntrypoint(route.entrypoint))),
					trailingSlash,
				});
			},
		},
	};
}

export class Webroot {
	readonly path: string;
	readonly configFile: string | null;
	readonly adapter: Adapter;
	readonly prerender: boolean;
	readonly port: number;
	readonly runtimePath: string | undefined;
	readonly caches: string;
	readonly projectCaches: string;
	readonly isolatedCache: boolean;
	readonly astroCache: string;
	readonly viteCache: string;
	readonly dist: string;
	readonly nextDist: string;
	readonly previousDist: string;
	readonly publicDir: string;

	constructor(config: WebrootConfig, configFile: string | null = null, isolatedCache: boolean = false) {
		const validated = validateConfig(config, configFile ?? "Webroot configuration");
		if (validated.webroots !== undefined) throw new Error("A Webroot represents one directory; use Webroot.search() to load webroots");
		this.configFile = configFile === null ? null : path.resolve(configFile);
		if (config.webroot) {
			if (!this.configFile && !path.isAbsolute(config.webroot)) {
				throw new Error("A config-free Webroot requires an absolute webroot path");
			}
			this.path = path.resolve(
				this.configFile ? path.dirname(this.configFile) : "",
				config.webroot,
			);
		} else if (this.configFile) {
			this.path = path.dirname(this.configFile);
		} else {
			throw new Error("Webroot requires config.webroot or a config file");
		}
		this.adapter = config.adapter ?? "node";
		this.prerender = config.prerender ?? true;
		this.port = config.port ?? 4321;
		this.runtimePath = config.runtimePath;
		this.caches = path.join(this.path, ".caches");
		this.isolatedCache = isolatedCache;
		this.projectCaches = path.join(this.configFile ? path.dirname(this.configFile) : this.path, ".caches");
		if (isolatedCache) {
			// Use the normalized path, not the array position, so reordering or
			// adding entries does not change existing cache identities.
			const relative = path.relative(path.dirname(this.projectCaches), this.path).split(path.sep).join("/") || ".";
			const hash = createHash("sha256").update(relative).digest("hex").slice(0, 16);
			const name = path.basename(this.path).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40) || "root";
			this.projectCaches = path.join(this.projectCaches, `${name}-${hash}`);
		}
		this.astroCache = path.join(this.projectCaches, ".astro");
		this.viteCache = path.join(this.astroCache, "vite");
		this.dist = path.join(this.caches, "dist");
		this.nextDist = path.join(this.caches, "next-dist");
		this.previousDist = path.join(this.caches, "previous-dist");
		this.publicDir = path.join(this.astroCache, "public");
	}

	private static fromLoadedConfig(loaded: LoadedWebrootConfig): Webroot {
		return new Webroot(loaded.config, loaded.configFile, loaded.isolatedCache);
	}

	static async search(directory: string = process.cwd()): Promise<Webroot[]> {
		return (await searchConfigs(directory)).map(Webroot.fromLoadedConfig);
	}

	static async requireAll(directory: string = process.cwd()): Promise<Webroot[]> {
		return (await requireConfigs(directory)).map(Webroot.fromLoadedConfig);
	}

	static async requireOne(directory: string = process.cwd()): Promise<Webroot> {
		return Webroot.fromLoadedConfig(await requireConfig(directory));
	}

	static async resolve(root: string, workingDirectory: string = process.cwd()): Promise<Webroot> {
		return Webroot.fromLoadedConfig(await resolveConfig(root, workingDirectory));
	}

	private requestPathParts(requestUrl: string | undefined): string[] | null {
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

	private hasPrivateDirectory(parts: string[]): boolean {
		return parts.some(part => PRIVATE_DIRECTORIES.has(part.toLowerCase()));
	}

	private resolveContainedFile(root: string, parts: string[]): string | null {
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

	isPrivateRequest(requestUrl: string | undefined): boolean {
		const parts = this.requestPathParts(requestUrl);
		return parts === null || this.hasPrivateDirectory(parts);
	}

	scanPages(): AstrohpPage[] {
		const pages: AstrohpPage[] = [];
		const patterns = new Map<string, string>();

		const scan = (directory: string): void => {
			for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
				if (entry.name.startsWith(".")) continue;
				const filename = path.join(directory, entry.name);
				if (entry.isDirectory()) {
					if (!PRIVATE_DIRECTORIES.has(entry.name.toLowerCase())) scan(filename);
					continue;
				}
				if (!entry.isFile() || !entry.name.endsWith(".astro")) continue;

				const relative = path.relative(this.path, filename);
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
		};

		scan(this.path);
		return pages.sort((a, b) => a.pattern.localeCompare(b.pattern));
	}

	resolveFile(requestUrl: string | undefined): string | null {
		const parts = this.requestPathParts(requestUrl);
		if (
			parts === null || !parts.length || this.hasPrivateDirectory(parts) ||
			parts.some(part => part.startsWith("."))
		) {
			return null;
		}

		const filename = this.resolveContainedFile(this.path, parts);
		if (!filename) return null;
		const relativeFilename = path.relative(fs.realpathSync(this.path), filename);
		return this.hasPrivateDirectory(relativeFilename.split(path.sep)) ?
			null :
			filename;
	}

	resolveStaticFile(requestUrl: string | undefined): string | null {
		const filename = this.resolveFile(requestUrl);
		if (
			!filename ||
			[".astro", ".ts", ".tsx"].includes(path.extname(filename).toLowerCase())
		) {
			return null;
		}
		return filename;
	}

	resolveDistFile(requestUrl: string | undefined): string | null {
		const parts = this.requestPathParts(requestUrl);
		if (parts === null || this.hasPrivateDirectory(parts)) return null;

		const candidates = !parts.length ?
			[["index.html"]] :
			path.extname(parts.at(-1)!) ?
			[parts] :
			[
				[...parts.slice(0, -1), `${parts.at(-1)}.html`],
				[...parts, "index.html"],
			];

		for (const candidate of candidates) {
			const filename = this.resolveContainedFile(this.dist, candidate);
			if (filename) return filename;
		}
		return null;
	}
}
