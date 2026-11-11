import fs from "node:fs";
import path from "node:path";
import type * as vite from "vite";
import { compileScript, scriptOutputPath } from "./babel.js";
import { scriptReferences } from "./script-references.js";
import type { Webroot } from "./webroot.js";

export function es3Plugin(webroot: Webroot, buildSources: Set<string> = new Set()): vite.Plugin {
	const references = new Map<string, Set<string>>();
	let server: vite.ViteDevServer | undefined;
	let queue = Promise.resolve();
	const referenced = (source: string): boolean => [...references.values()].some(sources => sources.has(source));
	const removeOutput = (source: string): void => {
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
						if (event === "unlink") removeOutput(filename);
						else await compileScript(webroot, filename);
						server!.ws.send({ type: "full-reload", path: "*" });
					} catch (error) {
						server!.config.logger.error(`AstroHP ES3: ${(error as Error).message}`);
					}
				});
			});
		},
		transform: {
			order: "pre",
			async handler(code, id) {
				if (!id.endsWith(".astro")) return;
				const result = scriptReferences(webroot, id, code, "ES3");
				const previous = references.get(id);
				references.set(id, new Set(result.sources));
				for (const source of result.sources) {
					buildSources.add(source);
					this.addWatchFile(source);
				}
				if (server) {
					await queue;
					for (const source of previous ?? []) if (!referenced(source)) removeOutput(source);
					await Promise.all(result.sources.map(source => compileScript(webroot, source)));
				}
				return { code: result.code, map: result.map.toString() };
			},
		},
	};
}
