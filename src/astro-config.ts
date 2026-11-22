import { satteri, type SatteriResolvedOptions } from "@astrojs/markdown-satteri";
import mdx from "@astrojs/mdx";
import nodeAdapter from "@astrojs/node";
import type * as astro from "astro";
import { fileURLToPath } from "node:url";
import type * as vite from "vite";

import { type AstralHPConfigOptions, astralhpIntegration } from "./astro-integration.js";
import { AssetBundles } from "./bundles.js";
import { cgiAdapter } from "./cgi-adapter.js";
import { ES3Scripts } from "./es3.js";
import { includeSuffixes } from "./request-policy.js";
import { sourcePathsPlugin } from "./source-paths.js";
import { relativePosixPath } from "./utils.js";
import type { AstralHPPage, Webroot } from "./webroot.js";

function outsideRootEntrypoints(
	webroot: Webroot,
	pages: AstralHPPage[],
): vite.Plugin {
	const markdownPages = pages.filter(page => page.markdownFile);
	const markdownModule = "virtual:astralhp/markdown-pages";
	const nodeImageEndpoint = fileURLToPath(
		import.meta.resolve("astro/assets/endpoint/node"),
	);
	const entrypoints = new Map(
		[...pages.map(page => page.entrypoint), nodeImageEndpoint].map(entrypoint => {
			const relative = relativePosixPath(webroot.projectCaches, entrypoint);
			return [`/${relative}`, entrypoint];
		}),
	);

	return {
		name: "astralhp:outside-root-entrypoints",
		enforce: "pre",
		resolveId(source) {
			if (source === markdownModule) return "\0" + markdownModule;
			if (
				source === "astro" || source.startsWith("astro/") ||
				source === "@astrojs/node" || source.startsWith("@astrojs/node/") ||
				source === "astralhp/components"
			) {
				try {
					return fileURLToPath(import.meta.resolve(source));
				} catch {}
			}
			return entrypoints.get(source) ?? null;
		},
		load(id) {
			if (id !== "\0" + markdownModule) return;
			const loaders = markdownPages.map(page =>
				`${JSON.stringify(page.pattern)}: () => import(${JSON.stringify(page.markdownFile)})`
			);
			return `export default {\n${loaders.join(",\n")}\n};`;
		},
	};
}

function pageEntrypoints(webroot: Webroot): AstralHPPage[] {
	const entrypoint = fileURLToPath(new URL("./components/MarkdownPage.astro", import.meta.url));
	return webroot.scanPages().map(page => {
		if (!/\.mdx?$/.test(page.entrypoint)) return page;
		return { ...page, markdownFile: page.entrypoint, entrypoint };
	});
}

function markdownProcessor(addTargetBlank: boolean) {
	const hastPlugins: SatteriResolvedOptions["hastPlugins"] = [{
		name: "astralhp-heading-title",
		element: {
			filter: ["h1", "h2", "h3", "h4", "h5", "h6"],
			visit(node, ctx) {
				const { frontmatter } = ctx.data.astro!;
				frontmatter.title ??= ctx.textContent(node);
			},
		},
	}];
	if (addTargetBlank) {
		hastPlugins.push({
			name: "astralhp-external-links",
			element: {
				filter: ["a"],
				visit(node, ctx) {
					const { href, target, rel } = node.properties;
					if (typeof href !== "string" || !/^(?:https?:)?\/\//i.test(href)) return;
					if (target && target !== "_blank") return;
					const tokens = Array.isArray(rel) ? rel : String(rel ?? "").split(/\s+/).filter(Boolean);
					ctx.setProperty(node, "rel", [...new Set([...tokens, "noopener"])].join(" "));
					ctx.setProperty(node, "target", "_blank");
				},
			},
		});
	}
	return satteri({ hastPlugins });
}

export function astroConfig(
	webroot: Webroot,
	options: AstralHPConfigOptions = {},
	es3: ES3Scripts = new ES3Scripts(webroot),
	bundles: AssetBundles = new AssetBundles(webroot, es3),
): astro.AstroInlineConfig {
	const { config } = webroot;
	const pages = pageEntrypoints(webroot);
	const staticOnly = config.adapter === "apache-static";

	return {
		root: webroot.projectCaches,
		cacheDir: webroot.astroCache,
		publicDir: webroot.publicDir,
		markdown: { processor: markdownProcessor(config.markdownAddTargetBlank) },
		output: staticOnly ? "static" : "server",
		...(staticOnly ? {} : {
			adapter: config.adapter === "apache-cgi" ? cgiAdapter() : nodeAdapter({ mode: "middleware" }),
		}),
		build: {
			client: "./",
			server: "./.server/",
			serverEntry: "app.mjs",
		},
		server: {
			port: config.port,
		},
		devToolbar: {
			enabled: false,
		},
		integrations: [
			astralhpIntegration(pages, {
				...options,
				entrypointRoot: webroot.projectCaches,
				staticOnly,
				prerender: config.prerender,
				markdownLayout: config.markdownLayout,
			}), mdx(),
		],
		vite: {
			root: config.webroot,
			cacheDir: webroot.viteCache,
			server: {
				fs: {
					// Vite replaces its default deny list. Keep those entries when adding includes.
					deny: [
						".env", ".env.*", "*.{crt,pem,key,p12,pfx,cer,der}", ".npmrc", ".yarnrc.yml", "**/.git/**",
						...includeSuffixes.map(suffix => "*" + suffix),
					],
				},
				watch: {
					ignored: ["**/.caches/**"],
				},
			},
			define: {
				"import.meta.env.ASTRALHP_WEBROOT": JSON.stringify(config.webroot),
			},
			plugins: [
				bundles.plugin(),
				es3.plugin(),
				outsideRootEntrypoints(webroot, pages),
				sourcePathsPlugin(webroot),
			],
		},
	};
}
