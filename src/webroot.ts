import type * as astro from "astro";
import type { MarkdownProcessor } from "astro/markdown";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Adapter, WebrootConfig } from "./config.d.ts";

import {
	canonicalPath,
	findProjectDir,
	type LoadedWebrootConfig,
	requireConfig,
	requireConfigs,
	resolveConfig,
	searchConfigs,
	validateConfig,
} from "./config-loader.js";

export { validateConfig } from "./config-loader.js";

const PRIVATE_DIRECTORIES = new Set([".caches", ".server", "node_modules"]);
const ENDPOINT_SUFFIX = /\.astro\.[jt]s$/i;
const ROUTE_SUFFIXES = [".astro", ".md", ".mdx", ".astro.js", ".astro.ts"];

export interface AstralHPPage {
	pattern: string;
	entrypoint: string;
	markdownFile?: string;
}

export interface AstralHPResolvedRoutes {
	routes: astro.IntegrationResolvedRoute[];
	trailingSlash: astro.AstroConfig["trailingSlash"];
}

export interface AstralHPConfigOptions {
	onRoutesResolved?: (resolved: AstralHPResolvedRoutes) => void;
	entrypointRoot?: string;
	staticOnly?: boolean;
	prerender?: boolean;
	markdownLayout?: string | undefined;
}

function withMarkdownLayout(processor: MarkdownProcessor, layout: string, pages: Set<string>): MarkdownProcessor {
	function pageFrontmatter(filename: string, frontmatter: Record<string, any> = {}) {
		if ("layout" in frontmatter || !pages.has(canonicalPath(filename))) return frontmatter;
		const relative = path.relative(path.dirname(filename), layout).split(path.sep).join("/");
		return { ...frontmatter, layout: "./" + relative };
	}
	return {
		...processor,
		async createRenderer(options) {
			const renderer = await processor.createRenderer(options);
			return {
				render(source, context) {
					if (context?.fileURL) {
						context = { ...context, frontmatter: pageFrontmatter(fileURLToPath(context.fileURL), context.frontmatter) };
					}
					return renderer.render(source, context);
				},
			};
		},
		async createMdxRenderer(options, mdxOptions) {
			const renderer = await processor.createMdxRenderer!(options, mdxOptions);
			return {
				process(source, filename, frontmatter) {
					return renderer.process(source, filename, pageFrontmatter(filename, frontmatter));
				},
			};
		},
	};
}

export function astralhpIntegration(
	pages: AstralHPPage[],
	options: AstralHPConfigOptions = {},
): astro.AstroIntegration {
	const entrypoints = new Set(
		pages.map(page => canonicalPath(page.entrypoint)),
	);
	const markdownPages = new Set(pages.flatMap(page => page.markdownFile ? [canonicalPath(page.markdownFile)] : []));
	let trailingSlash: astro.AstroConfig["trailingSlash"] = "ignore";
	const canonicalEntrypoint = (entrypoint: string): string =>
		canonicalPath(
			path.isAbsolute(entrypoint) ?
				entrypoint :
				path.resolve(options.entrypointRoot ?? "", entrypoint),
		);

	return {
		name: "astralhp",
		hooks: {
			"astro:config:setup"({ injectRoute, config, updateConfig }) {
				// Astro checks for src/pages when there are no injected routes.
				if (!pages.length) fs.mkdirSync(new URL("pages/", config.srcDir), { recursive: true });
				if (options.markdownLayout) {
					const processor = config.markdown.processor as MarkdownProcessor;
					updateConfig({
						markdown: { processor: withMarkdownLayout(processor, options.markdownLayout, markdownPages) },
					});
				}
				// Set page defaults independently of the adapter's output mode.
				// Astro still gives an explicit page export precedence over this.
				for (const { pattern, entrypoint } of pages) {
					injectRoute({ pattern, entrypoint, prerender: options.prerender ?? true });
				}
			},
			"astro:config:done"({ config }) {
				trailingSlash = config.trailingSlash;
			},
			"astro:build:setup"({ pages }) {
				// A static endpoint needs a filename. Apache and Node serve the built index at /.
				for (const { route } of pages.values()) {
					if (route.type === "endpoint" && route.prerender && route.pathname === "/") route.pathname = "/index";
				}
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
								'Set prerender = true on these pages or in astralhp.mts, or set adapter to "apache-cgi", "apache-proxy", or "node" in astralhp.mts.',
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
	readonly projectDir: string;
	readonly markdownAddTargetBlank: boolean;
	readonly excludePages: readonly string[];
	readonly markdownLayout: string | undefined;
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
		if (Array.isArray(validated.webroot)) {
			throw new Error("A Webroot represents one directory; use Webroot.search() to load webroots");
		}
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
		this.projectDir = findProjectDir(this.path, this.configFile);
		this.markdownAddTargetBlank = config.markdownAddTargetBlank ?? false;
		this.excludePages = config.excludePages ?? [];
		this.markdownLayout = config.markdownLayout &&
			path.resolve(this.projectDir, config.markdownLayout);
		this.adapter = config.adapter ?? "apache-static";
		this.prerender = config.prerender ?? true;
		this.port = config.port ?? 4321;
		this.runtimePath = config.runtimePath;
		this.caches = path.join(this.path, ".caches");
		this.isolatedCache = isolatedCache;
		this.projectCaches = this.configFile ? path.join(this.projectDir, ".caches") : this.caches;
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

	static fromLoadedConfig(loaded: LoadedWebrootConfig): Webroot {
		return new Webroot(loaded.config, loaded.configFile, loaded.isolatedCache);
	}

	static workerDirectory(webroots: readonly Webroot[]): string {
		if (!webroots.length) throw new Error("No AstralHP webroots found");
		let shared = webroots[0]!.projectDir;
		if (webroots.every(site => site.projectDir === shared)) return shared;
		for (const { projectDir } of webroots) {
			while (shared !== projectDir && !projectDir.startsWith(path.join(shared, path.sep))) {
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

	private requestPathParts(requestUrl: string | undefined): string[] | null {
		if (!requestUrl) return null;
		try {
			const pathname = decodeURIComponent(
				new URL(requestUrl, "http://astralhp.local").pathname,
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
		return parts === null || this.hasPrivateDirectory(parts) || ENDPOINT_SUFFIX.test(parts.at(-1) ?? "");
	}

	scanPages(): AstralHPPage[] {
		const pages: AstralHPPage[] = [];
		const patterns = new Map<string, string>();
		const excluded = new Set(this.excludePages.map(entry => path.resolve(this.path, entry)));

		const scan = (directory: string): void => {
			for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
				if (entry.name.startsWith(".")) continue;
				const filename = path.join(directory, entry.name);
				if (excluded.has(filename)) continue;
				if (entry.isDirectory()) {
					if (!PRIVATE_DIRECTORIES.has(entry.name.toLowerCase())) scan(filename);
					continue;
				}
				const extension = ROUTE_SUFFIXES.find(suffix => entry.name.endsWith(suffix));
				if (!entry.isFile() || !extension || filename === this.markdownLayout) {
					continue;
				}

				const relative = path.relative(this.path, filename);
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

		if (!excluded.has(this.path)) scan(this.path);
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
		const pathname = requestUrl?.split(/[?#]/, 1)[0];
		const filename = this.resolveFile(pathname?.endsWith("/") ? pathname + "index.html" : pathname);
		if (
			!filename || ENDPOINT_SUFFIX.test(filename) ||
			[".astro", ".md", ".mdx"].includes(path.extname(filename).toLowerCase())
		) {
			return null;
		}
		return filename;
	}

	resolveDistFile(requestUrl: string | undefined): string | null {
		const parts = this.requestPathParts(requestUrl);
		if (parts === null || this.hasPrivateDirectory(parts)) return null;

		const candidates = !parts.length ?
			[["index"], ["index.html"]] :
			path.extname(parts.at(-1)!) ?
			[parts] :
			[
				parts,
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
