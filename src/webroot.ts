import type * as astro from "astro";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type * as vite from "vite";
import type { Adapter, Config } from "./config.d.ts";

const PRIVATE_DIRECTORIES = new Set([".caches", "node_modules"]);
const ADAPTERS = new Set<Adapter>(["node", "apache-proxy"]);

export function validateConfig(value: any, filename: string): Config {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${filename} must export a configuration object named "config"`);
	}

	for (const key of Object.keys(value)) {
		if (key !== "webroot" && key !== "adapter" && key !== "port") {
			throw new Error(`Unknown AstroHP configuration option: ${key}`);
		}
	}
	if (
		value.webroot !== undefined &&
		(typeof value.webroot !== "string" || !value.webroot)
	) {
		throw new Error("AstroHP configuration option webroot must be a non-empty string");
	}
	if (
		value.adapter !== undefined &&
		(typeof value.adapter !== "string" || !ADAPTERS.has(value.adapter as Adapter))
	) {
		throw new Error(
			'AstroHP configuration option adapter must be "node" or "apache-proxy"',
		);
	}
	if (
		value.port !== undefined &&
		(typeof value.port !== "number" || !Number.isInteger(value.port) ||
			value.port < 0 || value.port > 65535)
	) {
		throw new Error(
			"AstroHP configuration option port must be an integer from 0 to 65535",
		);
	}
	return value as Config;
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

export class Webroot {
	readonly path: string;
	readonly configFile: string | null;
	readonly adapter: Adapter;
	readonly port: number;
	readonly caches: string;
	readonly astroCache: string;
	readonly viteCache: string;
	readonly dist: string;
	readonly nextDist: string;
	readonly previousDist: string;
	readonly publicDir: string;

	constructor(config: Config, configFile: string | null = null) {
		validateConfig(config, configFile ?? "Webroot configuration");
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
		this.port = config.port ?? 4321;
		this.caches = path.join(this.path, ".caches");
		this.astroCache = path.join(this.caches, ".astro");
		this.viteCache = path.join(this.astroCache, "vite");
		this.dist = path.join(this.caches, "dist");
		this.nextDist = path.join(this.caches, "next-dist");
		this.previousDist = path.join(this.caches, "previous-dist");
		this.publicDir = path.join(this.astroCache, "public");
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

	private outsideRootEntrypoints(pages: AstrohpPage[]): vite.Plugin {
		const compilerRuntime = fileURLToPath(
			import.meta.resolve("astro/compiler-runtime"),
		);
		const components = fileURLToPath(import.meta.resolve("astrohp/components"));
		const entrypoints = new Map(
			pages.map(page => {
				const relative = path
					.relative(this.caches, page.entrypoint)
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

	astroConfig(
		options: AstrohpConfigOptions = {},
	): astro.AstroInlineConfig {
		const pages = this.scanPages();
		if (!pages.length) {
			throw new Error(`No .astro pages found in ${this.path}`);
		}

		return {
			root: this.caches,
			cacheDir: this.astroCache,
			publicDir: this.publicDir,
			devToolbar: {
				enabled: false,
			},
			integrations: [astrohpIntegration(pages, options)],
			vite: {
				root: this.path,
				cacheDir: this.viteCache,
				server: {
					watch: {
						ignored: ["**/.caches/**"],
					},
				},
				define: {
					"import.meta.env.ASTROHP_WEBROOT": JSON.stringify(this.path),
				},
				plugins: [this.outsideRootEntrypoints(pages)],
			},
		};
	}
}
