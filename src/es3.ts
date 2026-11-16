import MagicString from "magic-string";
import fs from "node:fs";
import type * as vite from "vite";
import { assetReferences } from "./asset-references.js";
import { compileScript, prepareScript, type ScriptCache, scriptOutputPath } from "./babel.js";
import { contentHash } from "./cachebuster.js";
import type { Webroot } from "./webroot.js";

export function es3Plugin(
	webroot: Webroot,
	buildSources: Set<string> = new Set(),
	cache: ScriptCache = new Map(),
): vite.Plugin {
	const references = new Map<string, Set<string>>();
	let server: vite.ViteDevServer | undefined;
	let queue = Promise.resolve();
	const referenced = (source: string): boolean => [...references.values()].some(sources => sources.has(source));
	const removeOutput = (source: string): void => {
		cache.delete(source);
		const output = scriptOutputPath(webroot.path, webroot.dist, source);
		fs.rmSync(output, { force: true });
		fs.rmSync(`${output}.map`, { force: true });
	};
	const forget = (filename: string): void => {
		const previous = references.get(filename);
		references.delete(filename);
		for (const source of previous ?? []) if (!referenced(source)) removeOutput(source);
	};
	return {
		name: "astrohp:es3",
		enforce: "pre",
		configureServer(devServer) {
			server = devServer;
			server.watcher.on("all", (event, filename) => {
				if (event !== "add" && event !== "change" && event !== "unlink") return;
				if (event === "unlink" && references.has(filename)) forget(filename);
				if (!referenced(filename)) return;
				queue = queue.then(async () => {
					try {
						cache.delete(filename);
						if (event === "unlink") removeOutput(filename);
						else await compileScript(webroot, filename, webroot.dist, cache);
						for (const environment of Object.values(server!.environments)) environment.moduleGraph.invalidateAll();
						server!.ws.send({ type: "full-reload", path: "*" });
					} catch (error) {
						cache.delete(filename);
						server!.config.logger.error(`AstroHP ES3: ${(error as Error).message}`);
					}
				});
			});
		},
		transform: {
			order: "pre",
			async handler(code, id) {
				if (!id.endsWith(".astro")) return;
				const result = assetReferences(webroot, id, code, "ES3");
				const previous = references.get(id);
				references.set(id, new Set(result.sources));
				for (const source of result.sources) {
					buildSources.add(source);
					this.addWatchFile(source);
				}
				if (server) {
					await queue;
					for (const source of previous ?? []) if (!referenced(source)) removeOutput(source);
					await Promise.all(result.sources.map(source => compileScript(webroot, source, webroot.dist, cache)));
				}
				const output = new MagicString(code);
				for (const reference of result.assets) {
					output.overwrite(reference.start, reference.end, `{${JSON.stringify(reference.pathname)}}`);
					if (!result.sources.includes(reference.source)) continue;
					let pending = cache.get(reference.source);
					if (!pending) {
						pending = prepareScript(webroot, reference.source, webroot.nextDist);
						cache.set(reference.source, pending);
						pending.catch(() => cache.delete(reference.source));
					}
					const compiled = await pending;
					if (!compiled) throw new Error(`No compiled script produced for ${reference.source}`);
					const src = `${reference.pathname.replace(/\.tsx?$/, ".js")}?v=${contentHash(compiled.code)}`;
					output.appendLeft(reference.insert, ` __astrohpSrc={${JSON.stringify(src)}}`);
				}
				return {
					code: output.toString(),
					map: output.generateMap({ hires: true, source: id, includeContent: true }).toString(),
				};
			},
		},
	};
}
