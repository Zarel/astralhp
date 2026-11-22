import fs from "node:fs";
import path from "node:path";
import type { WebrootConfig } from "./config.d.ts";

import {
	findProjectDir,
	type LoadedWebrootConfig,
	requireConfig,
	requireConfigs,
	resolveConfig,
	searchConfigs,
	validateConfig,
	withWebrootDefaults,
} from "./config-loader.js";
import * as requestPolicy from "./request-policy.js";
import { contentHash, isPathInside, relativePosixPath } from "./utils.js";

export { validateConfig } from "./config-loader.js";

export interface AstralHPPage {
	pattern: string;
	entrypoint: string;
	markdownFile?: string;
}

export type Lookup =
	{ kind: "private" } |
	{ kind: "file"; filename: string; from: "dist" | "webroot" } |
	{ kind: "miss" };

export class Webroot {
	readonly config: Readonly<Required<WebrootConfig>>;
	readonly projectDir: string;
	readonly configFile: string | null;
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
		if (Array.isArray(validated.webroot)) {
			throw new Error("A Webroot represents one directory; use Webroot.search() to load webroots");
		}
		this.configFile = configFile === null ? null : path.resolve(configFile);
		const resolved = withWebrootDefaults(config);
		if (this.configFile) {
			resolved.webroot = path.resolve(path.dirname(this.configFile), resolved.webroot);
		} else {
			if (!config.webroot) throw new Error("Webroot requires config.webroot or a config file");
			if (!path.isAbsolute(config.webroot)) throw new Error("A config-free Webroot requires an absolute webroot path");
			resolved.webroot = path.resolve(config.webroot);
		}
		this.projectDir = findProjectDir(resolved.webroot, this.configFile);
		if (resolved.markdownLayout) resolved.markdownLayout = path.resolve(this.projectDir, resolved.markdownLayout);
		this.config = resolved;
		this.caches = path.join(this.config.webroot, ".caches");
		this.isolatedCache = isolatedCache;
		this.projectCaches = this.configFile ? path.join(this.projectDir, ".caches") : this.caches;
		if (isolatedCache) {
			// Use the normalized path, not the array position, so reordering or
			// adding entries does not change existing cache identities.
			const relative = relativePosixPath(path.dirname(this.projectCaches), this.config.webroot) || ".";
			const hash = contentHash(relative);
			const name = path.basename(this.config.webroot).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40) || "root";
			this.projectCaches = path.join(this.projectCaches, `${name}-${hash}`);
		}
		this.astroCache = path.join(this.projectCaches, ".astro");
		this.viteCache = path.join(this.astroCache, "vite");
		this.dist = path.join(this.caches, "dist");
		this.nextDist = path.join(this.caches, "next-dist");
		this.previousDist = path.join(this.caches, "previous-dist");
		this.publicDir = path.join(this.astroCache, "public");
	}

	static fromLoadedConfig(loaded: LoadedWebrootConfig): Webroot {
		return new Webroot(loaded.config, loaded.configFile, loaded.isolatedCache);
	}

	static workerDirectory(webroots: readonly Webroot[]): string {
		if (!webroots.length) throw new Error("No AstralHP webroots found");
		let shared = webroots[0]!.projectDir;
		if (webroots.every(site => site.projectDir === shared)) return shared;
		for (const { projectDir } of webroots) {
			while (!isPathInside(shared, projectDir)) {
				const parent = path.dirname(shared);
				if (parent === shared) throw new Error("The webroots must share a filesystem root");
				shared = parent;
			}
		}
		return findProjectDir(shared);
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

	static async resolve(webroot: string, workingDirectory: string = process.cwd()): Promise<Webroot> {
		return Webroot.fromLoadedConfig(await resolveConfig(webroot, workingDirectory));
	}

	scanPages(): AstralHPPage[] {
		const pages: AstralHPPage[] = [];
		const patterns = new Map<string, string>();
		const excluded = new Set(this.config.excludePages.map(entry => path.resolve(this.config.webroot, entry)));

		const scan = (directory: string): void => {
			for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
				if (entry.name.startsWith(".")) continue;
				const filename = path.join(directory, entry.name);
				if (excluded.has(filename)) continue;
				if (entry.isDirectory()) {
					if (!requestPolicy.privatePath.test(entry.name)) scan(filename);
					continue;
				}
				if (!entry.isFile() || requestPolicy.includeSource.test(entry.name)) continue;
				const extension = requestPolicy.routeSuffixes.find(suffix => entry.name.endsWith(suffix));
				if (!extension || filename === this.config.markdownLayout) continue;

				const relative = path.relative(this.config.webroot, filename);
				const segments = relative.split(path.sep);
				const basename = segments.pop()!.slice(0, -extension.length);
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

		if (!excluded.has(this.config.webroot)) scan(this.config.webroot);
		return pages.sort((a, b) => a.pattern.localeCompare(b.pattern));
	}

	private findFile(root: string, candidates: string[][]): string | null {
		let realRoot: string | undefined;
		for (const parts of candidates) {
			const filename = path.resolve(root, ...parts);
			if (!isPathInside(root, filename)) continue;
			try {
				if (!fs.statSync(filename, { throwIfNoEntry: false })?.isFile()) continue;
				realRoot ??= fs.realpathSync(root);
				const realFile = fs.realpathSync(filename);
				if (!isPathInside(realRoot, realFile)) continue;
				const relative = relativePosixPath(realRoot, realFile);
				const serveSourceFiles = root !== this.dist || this.config.serveSourceFiles;
				if (!requestPolicy.allowsResolvedFile(relative, serveSourceFiles)) continue;
				return realFile;
			} catch {
				continue;
			}
		}
		return null;
	}

	private webrootFile(parts: string[]): string | null {
		if (!parts.length) return null;
		return this.findFile(this.config.webroot, [parts]);
	}

	/** Resolve an input for the asset compilers, including sources hidden from HTTP. */
	resolveFile(requestUrl: string | URL | undefined): string | null {
		const path = requestPolicy.parsePath(requestUrl);
		return path && this.webrootFile(path.parts);
	}

	private distFile(parts: string[]): string | null {
		const name = parts.at(-1);
		if (!name) return this.findFile(this.dist, [["index"], ["index.html"]]);
		if (path.extname(name)) return this.findFile(this.dist, [parts]);
		return this.findFile(this.dist, [parts, [...parts.slice(0, -1), name + ".html"], [...parts, "index.html"]]);
	}

	lookup(requestUrl: string | URL | undefined, { dist = true }: { dist?: boolean } = {}): Lookup {
		const request = requestPolicy.parsePath(requestUrl);
		if (!request) return { kind: "private" };
		const { parts, directoryIndex } = request;
		const kind = requestPolicy.classifyRequest(parts, this.config.serveSourceFiles);
		if (kind) return { kind };

		if (dist) {
			const filename = this.distFile(parts);
			if (filename) return { kind: "file", filename, from: "dist" };
		}

		const filename = this.webrootFile(directoryIndex ? [...parts, "index.html"] : parts);
		if (!filename) return { kind: "miss" };
		if (requestPolicy.hidesOriginal(filename, parts.at(-1) ?? "", this.config.serveSourceFiles)) {
			return { kind: "private" };
		}
		return { kind: "file", filename, from: "webroot" };
	}
}
