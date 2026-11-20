import mdx from "@astrojs/mdx";
import nodeAdapter from "@astrojs/node";
import type * as astro from "astro";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type * as vite from "vite";

import type { ScriptCache } from "./babel.js";
import { buildSite } from "./build.js";
import { AssetBundles } from "./bundles.js";
import { cgiAdapter } from "./cgi-adapter.js";
import { type DevServerOptions, startDev } from "./dev-server.js";
import { es3Plugin } from "./es3.js";
import { type LiveServerOptions, serverPort, startLive } from "./live-server.js";
import {
	type AstralHPConfigOptions,
	astralhpIntegration,
	type AstralHPPage,
	type AstralHPResolvedRoutes,
	Webroot,
} from "./webroot.js";

interface SerializedWebroot {
	path: string;
	configFile: string | null;
	isolatedCache: boolean;
	adapter: Webroot["adapter"];
	prerender: boolean;
	port: number;
	runtimePath?: string | undefined;
	defaultMarkdownLayout?: string | undefined;
}

interface WorkerRequest {
	operation: "build" | "dev" | "start";
	webroots: SerializedWebroot[];
	options?: DevServerOptions | LiveServerOptions;
}

function webrootFrom(data: SerializedWebroot): Webroot {
	return new Webroot(
		{
			webroot: data.path,
			adapter: data.adapter,
			prerender: data.prerender,
			port: data.port,
			defaultMarkdownLayout: data.defaultMarkdownLayout,
			runtimePath: data.runtimePath,
		},
		data.configFile,
		data.isolatedCache,
	);
}

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
			const relative = path.relative(webroot.projectCaches, entrypoint)
				.split(path.sep).join("/");
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
		if (page.entrypoint.endsWith(".astro")) return page;
		return { ...page, markdownFile: page.entrypoint, entrypoint };
	});
}

function astroConfig(
	webroot: Webroot,
	options: AstralHPConfigOptions = {},
	legacySources: Set<string> = new Set(),
	bundles: AssetBundles = new AssetBundles(webroot),
	legacyCache: ScriptCache = new Map(),
): astro.AstroInlineConfig {
	const pages = pageEntrypoints(webroot);
	const staticOnly = webroot.adapter === "apache-static";

	return {
		root: webroot.projectCaches,
		cacheDir: webroot.astroCache,
		publicDir: webroot.publicDir,
		output: staticOnly ? "static" : "server",
		...(staticOnly ? {} : {
			adapter: webroot.adapter === "apache-cgi" ? cgiAdapter() : nodeAdapter({ mode: "middleware" }),
		}),
		build: {
			client: "./",
			server: "./.server/",
			serverEntry: "app.mjs",
		},
		server: {
			port: webroot.port,
		},
		devToolbar: {
			enabled: false,
		},
		integrations: [
			astralhpIntegration(pages, {
				...options,
				entrypointRoot: webroot.projectCaches,
				staticOnly,
				prerender: webroot.prerender,
				defaultMarkdownLayout: webroot.defaultMarkdownLayout,
			}), mdx(),
		],
		vite: {
			root: webroot.path,
			cacheDir: webroot.viteCache,
			server: {
				watch: {
					ignored: ["**/.caches/**"],
				},
			},
			define: {
				"import.meta.env.ASTRALHP_WEBROOT": JSON.stringify(webroot.path),
			},
			plugins: [
				bundles.plugin(legacySources),
				es3Plugin(webroot, legacySources, legacyCache),
				outsideRootEntrypoints(webroot, pages),
			],
		},
	};
}

function send(message: object): Promise<void> {
	return new Promise((resolve, reject) => {
		if (!process.send) {
			reject(new Error("AstralHP worker requires an IPC channel"));
			return;
		}
		process.send(message, error => error ? reject(error) : resolve());
	});
}

function serializedError(error: unknown) {
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
			...(error.stack === undefined ? {} : { stack: error.stack }),
		};
	}
	return {
		name: "Error",
		message: String(error),
	};
}

let close: (() => Promise<void>) | undefined;
let closing = false;

async function shutdown(): Promise<void> {
	if (closing) return;
	closing = true;
	try {
		await close?.();
		if (process.connected) process.disconnect();
	} catch (error) {
		console.error(error);
		process.exitCode = 1;
		if (process.connected) process.disconnect();
	}
}

async function run(request: WorkerRequest): Promise<void> {
	const webroots = request.webroots.map(webrootFrom);
	switch (request.operation) {
		case "build": {
			if (webroots.length !== 1) {
				throw new Error("An AstralHP build worker requires exactly one webroot");
			}
			let resolvedRoutes: AstralHPResolvedRoutes | undefined;
			const legacySources = new Set<string>();
			const legacyCache: ScriptCache = new Map();
			const bundles = new AssetBundles(webroots[0]!);
			const config = astroConfig(
				webroots[0]!,
				{
					onRoutesResolved(value) {
						resolvedRoutes = value;
					},
				},
				legacySources,
				bundles,
				legacyCache,
			);
			const result = await buildSite(
				webroots[0]!,
				config,
				() => resolvedRoutes,
				legacySources,
				bundles,
				legacyCache,
			);
			await send({ type: "ready", result });
			process.disconnect();
			break;
		}
		case "dev": {
			if (webroots.length !== 1) {
				throw new Error("An AstralHP dev worker requires exactly one webroot");
			}
			const options = request.options as DevServerOptions | undefined;
			const server = await startDev(webroots[0]!, astroConfig(webroots[0]!), {
				...options,
				port: options?.port ?? serverPort(webroots[0]!.port),
			});
			close = () => server.stop();
			await send({ type: "ready" });
			break;
		}
		case "start": {
			const servers = await startLive(
				webroots,
				request.options as LiveServerOptions | undefined,
			);
			close = async () => {
				await Promise.all(servers.map(server => server.close()));
				process.exit(0);
			};
			await send({
				type: "ready",
				result: {
					urls: servers.map(server => server.url),
					startupMessage: servers.map(server => server.startupMessage).join("\n"),
				},
			});
			break;
		}
	}
}

process.once("message", (request: WorkerRequest) => {
	run(request).catch(async error => {
		try {
			await send({ type: "error", error: serializedError(error) });
		} catch {}
		if (request.operation === "start") process.exit(1);
		process.exitCode = 1;
		if (process.connected) process.disconnect();
	});
});

process.on("message", message => {
	if (
		message && typeof message === "object" &&
		"type" in message && message.type === "close"
	) {
		void shutdown();
	}
});

process.on("disconnect", () => {
	void shutdown();
});
