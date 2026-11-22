import MagicString from "magic-string";
import fs from "node:fs";
import type * as vite from "vite";
import { assetReferences } from "./asset-references.js";
import { type CompiledES3Script, es3OutputPath, prepareES3Script, writeCompiledES3Script } from "./es3-compiler.js";
import { contentHash } from "./utils.js";
import type { Webroot } from "./webroot.js";

export class ES3Scripts {
	readonly sources: Set<string> = new Set();
	private readonly webroot: Webroot;
	private readonly cache = new Map<string, Promise<CompiledES3Script | null>>();
	private readonly references = new Map<string, Set<string>>();

	constructor(webroot: Webroot) {
		this.webroot = webroot;
	}

	private prepare(source: string, dist: string): Promise<CompiledES3Script | null> {
		let pending = this.cache.get(source);
		if (!pending) {
			pending = prepareES3Script(this.webroot, source, dist);
			this.cache.set(source, pending);
			pending.catch(() => {
				if (this.cache.get(source) === pending) this.cache.delete(source);
			});
		}
		return pending;
	}

	private async write(source: string, dist: string): Promise<void> {
		const output = es3OutputPath(this.webroot.config.webroot, dist, source);
		writeCompiledES3Script(source, output, await this.prepare(source, dist));
	}

	async writeTo(dist: string): Promise<void> {
		await Promise.all([...this.sources].map(source => this.write(source, dist)));
	}

	private referenced(source: string): boolean {
		return [...this.references.values()].some(sources => sources.has(source));
	}

	private removeOutput(source: string): void {
		this.cache.delete(source);
		const output = es3OutputPath(this.webroot.config.webroot, this.webroot.dist, source);
		fs.rmSync(output, { force: true });
		fs.rmSync(`${output}.map`, { force: true });
	}

	private removeUnused(sources: Iterable<string>): void {
		for (const source of sources) {
			if (this.referenced(source)) continue;
			this.sources.delete(source);
			this.removeOutput(source);
		}
	}

	plugin(): vite.Plugin {
		const scripts = this;
		const { webroot } = this;
		let server: vite.ViteDevServer | undefined;
		let queue = Promise.resolve();
		return {
			name: "astralhp:es3",
			enforce: "pre",
			configureServer: devServer => {
				server = devServer;
				server.watcher.on("all", (event, filename) => {
					if (event !== "add" && event !== "change" && event !== "unlink") return;
					if (event === "unlink") {
						const previous = scripts.references.get(filename);
						scripts.references.delete(filename);
						if (previous) scripts.removeUnused(previous);
					}
					if (!scripts.referenced(filename)) return;
					queue = queue.then(async () => {
						try {
							if (event === "unlink") {
								scripts.removeOutput(filename);
							} else {
								scripts.cache.delete(filename);
								await scripts.write(filename, webroot.dist);
							}
							for (const environment of Object.values(devServer.environments)) environment.moduleGraph.invalidateAll();
							devServer.ws.send({ type: "full-reload", path: "*" });
						} catch (error) {
							devServer.config.logger.error(`AstralHP ES3: ${(error as Error).message}`);
						}
					});
				});
			},
			transform: {
				order: "pre",
				async handler(code, id) {
					if (!id.endsWith(".astro")) return;
					const result = assetReferences(webroot, id, code, "ES3");
					const previous = scripts.references.get(id);
					scripts.references.set(id, new Set(result.sources));
					for (const source of result.sources) {
						scripts.sources.add(source);
						this.addWatchFile(source);
					}
					if (server) {
						await queue;
						if (previous) scripts.removeUnused(previous);
						await Promise.all(result.sources.map(source => scripts.write(source, webroot.dist)));
					}
					const output = new MagicString(code);
					for (const reference of result.assets) {
						output.overwrite(reference.start, reference.end, `{${JSON.stringify(reference.pathname)}}`);
						if (!result.sources.includes(reference.source)) continue;
						const compiled = await scripts.prepare(reference.source, server ? webroot.dist : webroot.nextDist);
						if (!compiled) throw new Error(`No compiled script produced for ${reference.source}`);
						const src = `${reference.pathname.replace(/\.tsx?$/, ".js")}?v=${contentHash(compiled.code)}`;
						output.appendLeft(reference.insert, ` __astralhpSrc={${JSON.stringify(src)}}`);
					}
					return {
						code: output.toString(),
						map: output.generateMap({ hires: true, source: id, includeContent: true }).toString(),
					};
				},
			},
		};
	}
}
