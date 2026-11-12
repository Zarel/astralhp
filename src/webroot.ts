import type * as astro from "astro";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Adapter, Config } from "./config.d.ts";

const CONFIG_FILENAMES = ["astrohp.mts", ".astrohp.mts"] as const;
const IGNORED_DIRECTORIES = new Set(["node_modules", ".git", ".caches"]);
const PRIVATE_DIRECTORIES = new Set([".caches", ".server", "node_modules"]);
const ADAPTERS = new Set<Adapter>(["node", "apache-proxy", "apache-cgi"]);

export function validateConfig(value: any, filename: string): Config {
	// note to self: if this gets too complicated later, switch to Zod
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${filename} must export a configuration object named "config"`);
	}

	for (const key of Object.keys(value)) {
		if (key !== "webroot" && key !== "adapter" && key !== "port" && key !== "runtimePath") {
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
		throw new Error('AstroHP configuration option adapter must be "node", "apache-proxy", or "apache-cgi"');
	}
	if (
		value.port !== undefined &&
		(typeof value.port !== "number" || !Number.isInteger(value.port) ||
			value.port < 0 || value.port > 65535)
	) {
		throw new Error("AstroHP configuration option port must be an integer from 0 to 65535");
	}
	if (
		value.runtimePath !== undefined && (typeof value.runtimePath !== "string" ||
			!path.isAbsolute(value.runtimePath) || /[\s\0]/.test(value.runtimePath))
	) {
		throw new Error("AstroHP configuration option runtimePath must be an absolute path without whitespace");
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
	entrypointRoot?: string;
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
				for (const page of pages) injectRoute(page);
			},
			"astro:config:done"({ config }) {
				trailingSlash = config.trailingSlash;
			},
			"astro:routes:resolved"({ routes }) {
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
	readonly port: number;
	readonly runtimePath: string | undefined;
	readonly caches: string;
	readonly projectCaches: string;
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
		this.runtimePath = config.runtimePath;
		this.caches = path.join(this.path, ".caches");
		this.projectCaches = path.join(this.configFile ? path.dirname(this.configFile) : this.path, ".caches");
		this.astroCache = path.join(this.projectCaches, ".astro");
		this.viteCache = path.join(this.astroCache, "vite");
		this.dist = path.join(this.caches, "dist");
		this.nextDist = path.join(this.caches, "next-dist");
		this.previousDist = path.join(this.caches, "previous-dist");
		this.publicDir = path.join(this.astroCache, "public");
	}

	private static configIn(directory: string): string | null {
		const matches: string[] = [];
		for (const basename of CONFIG_FILENAMES) {
			const filename = path.join(directory, basename);
			try {
				if (fs.statSync(filename).isFile()) matches.push(filename);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		if (matches.length > 1) {
			throw new Error(
				`Found both ${CONFIG_FILENAMES.join(" and ")} in ${directory}`,
			);
		}
		return matches[0] ?? null;
	}

	private static findChildConfigs(
		directory: string,
		configs: string[],
	): void {
		const config = Webroot.configIn(directory);
		if (config) configs.push(config);

		const entries = fs.readdirSync(directory, { withFileTypes: true })
			.sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			if (!entry.isDirectory() || IGNORED_DIRECTORIES.has(entry.name)) continue;
			Webroot.findChildConfigs(path.join(directory, entry.name), configs);
		}
	}

	private static async importConfig(filename: string): Promise<Config> {
		const url = pathToFileURL(filename);
		url.searchParams.set("mtime", String(fs.statSync(filename).mtimeMs));
		const module = await import(/* @vite-ignore */ url.href) as Record<string, unknown>;
		if (!("config" in module)) {
			throw new Error(
				`${filename} must export a configuration object named "config"`,
			);
		}
		return module.config as Config;
	}

	static async search(
		directory: string = process.cwd(),
	): Promise<Webroot[]> {
		directory = path.resolve(directory);
		const configs: string[] = [];
		Webroot.findChildConfigs(directory, configs);

		let parent = path.dirname(directory);
		while (parent !== directory) {
			const config = Webroot.configIn(parent);
			if (config) configs.push(config);
			const nextParent = path.dirname(parent);
			if (nextParent === parent) break;
			parent = nextParent;
		}

		const webroots = await Promise.all(
			configs.map(async filename => new Webroot(await Webroot.importConfig(filename), filename)),
		);
		const webrootsByPath = new Map<string, Webroot>();
		for (const webroot of webroots) {
			const existing = webrootsByPath.get(webroot.path);
			if (existing) {
				throw new Error(
					`Webroot ${webroot.path} is configured by both ${existing.configFile} and ${webroot.configFile}`,
				);
			}
			webrootsByPath.set(webroot.path, webroot);
		}
		return webroots;
	}

	static async requireAll(
		directory: string = process.cwd(),
	): Promise<Webroot[]> {
		const webroots = await Webroot.search(directory);
		if (!webroots.length) {
			throw new Error(
				`Could not find ${CONFIG_FILENAMES.join(" or ")}; specify a webroot directory`,
			);
		}
		return webroots;
	}

	static async requireOne(
		directory: string = process.cwd(),
	): Promise<Webroot> {
		const webroots = await Webroot.requireAll(directory);
		if (webroots.length > 1) {
			throw new Error(
				`Found multiple AstroHP webroots; specify one:\n${webroots.map(webroot => webroot.path).join("\n")}`,
			);
		}
		return webroots[0]!;
	}

	static async resolve(
		root: string,
		workingDirectory: string = process.cwd(),
	): Promise<Webroot> {
		const requestedRoot = path.resolve(workingDirectory, root);
		const matches = (await Webroot.search(requestedRoot))
			.filter(webroot => webroot.path === requestedRoot);
		if (matches.length > 1) {
			throw new Error(`Found multiple configurations for ${requestedRoot}`);
		}
		return matches[0] ?? new Webroot({ webroot: requestedRoot });
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
