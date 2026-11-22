import type * as astro from "astro";
import type { MarkdownProcessor } from "astro/markdown";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalPath, relativePosixPath } from "./utils.js";
import type { AstralHPPage } from "./webroot.js";

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
		const relative = relativePosixPath(path.dirname(filename), layout);
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
