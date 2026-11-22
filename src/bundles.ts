import MagicString from "magic-string";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compileAsync } from "sass";
import type * as vite from "vite";
import { assetReferences } from "./asset-references.js";
import { es3OutputPath } from "./es3-compiler.js";
import type { ES3Scripts } from "./es3.js";
import { inlineCSS, inlineJS } from "./inline-assets.js";
import { contentHash, publicURL } from "./utils.js";
import type { Webroot } from "./webroot.js";

// Resolve the toolchain from Astro, including when it has a nested Vite install.
const viteURL = pathToFileURL(createRequire(import.meta.resolve("astro")).resolve("vite")).href;
const TARGET = ["chrome64", "firefox67", "safari11.1", "edge79"];

interface Bundle {
	src: string;
	styles: string[];
	files: Map<string, string | Uint8Array>;
	dependencies: Set<string>;
	content: string;
}

export class AssetBundles {
	private readonly webroot: Webroot;
	private readonly es3: ES3Scripts;
	private readonly bundles = new Map<string, Promise<Bundle>>();
	private readonly owners = new Map<string, string>();

	constructor(webroot: Webroot, es3: ES3Scripts) {
		this.es3 = es3;
		this.webroot = webroot;
	}

	private bundle(source: string): Promise<Bundle> {
		let pending = this.bundles.get(source);
		if (!pending) {
			pending = this.compile(source);
			this.bundles.set(source, pending);
			pending.catch(() => {
				if (this.bundles.get(source) === pending) this.bundles.delete(source);
			});
		}
		return pending;
	}

	private async compile(source: string): Promise<Bundle> {
		const scss = source.endsWith(".scss");
		const entry = path.relative(this.webroot.config.webroot, source)
			.replace(/\.scss$/, ".css")
			.replace(/\.(?:[cm]?js|jsx|tsx?)$/, ".min.js");
		const owner = this.owners.get(entry);
		if (owner && owner !== source) {
			throw new Error(`Asset output collision: ${owner} and ${source} both produce ${entry}`);
		}
		this.owners.set(entry, source);
		if (source.endsWith(".css")) {
			const content = fs.readFileSync(source, "utf8");
			return {
				src: `${publicURL(entry)}?v=${contentHash(content)}`,
				styles: [],
				files: new Map(),
				dependencies: new Set([source]),
				content,
			};
		}
		if (scss) return this.compileScss(source, entry);
		const directory = path.dirname(entry);
		const dependencies = new Set<string>([source]);
		const { build } = await import(viteURL) as typeof vite;
		const result = await build({
			configFile: false,
			root: this.webroot.config.webroot,
			publicDir: false,
			base: "./",
			logLevel: "error",
			plugins: [{
				name: "astralhp:bundle-dependencies",
				buildEnd() {
					for (const filename of this.getModuleIds()) {
						const clean = filename.split("?")[0]!;
						if (path.isAbsolute(clean) && fs.existsSync(clean)) dependencies.add(clean);
					}
				},
			}],
			build: {
				target: TARGET,
				write: false,
				emptyOutDir: false,
				outDir: path.join(this.webroot.nextDist, directory),
				sourcemap: true,
				assetsInlineLimit: 0,
				rollupOptions: {
					input: source,
					preserveEntrySignatures: "strict",
					output: {
						format: "es",
						entryFileNames: path.basename(entry),
						chunkFileNames: "_chunks/[name]-[hash].js",
						assetFileNames: "_assets/[name]-[hash][extname]",
					},
				},
			},
		});
		if (!("output" in result)) throw new Error("Expected a single JS bundle output");
		const files = new Map<string, string | Uint8Array>();
		const styles: string[] = [];
		const hash = createHash("sha256");
		for (const item of [...result.output].sort((a, b) => a.fileName.localeCompare(b.fileName))) {
			const filename = path.join(directory, item.fileName);
			const contents = item.type === "chunk" ? item.code : item.source;
			files.set(filename, contents);
			// Include CSS and lazy chunks, but not source maps containing local paths.
			if (!filename.endsWith(".map")) hash.update(filename).update("\0").update(contents).update("\0");
			if (item.type === "chunk" && item.isEntry) {
				const css = (item as typeof item & { viteMetadata?: { importedCss: Set<string> } }).viteMetadata?.importedCss;
				for (const file of css ?? []) styles.push(publicURL(path.join(directory, file)));
			}
		}
		return {
			src: `${publicURL(entry)}?v=${hash.digest("hex").slice(0, 16)}`,
			styles,
			files,
			dependencies,
			content: String(files.get(entry)),
		};
	}

	private async compileScss(source: string, entry: string): Promise<Bundle> {
		const result = await compileAsync(source, {
			style: "compressed",
			sourceMap: true,
			sourceMapIncludeSources: true,
		});
		const files = new Map<string, string | Uint8Array>();
		let css = result.css;
		if (result.sourceMap) {
			files.set(`${entry}.map`, JSON.stringify(result.sourceMap));
			css += `\n/*# sourceMappingURL=${encodeURIComponent(path.basename(entry))}.map */`;
		}
		files.set(entry, css);
		return {
			src: `${publicURL(entry)}?v=${contentHash(css)}`,
			styles: [],
			files,
			dependencies: new Set(result.loadedUrls.filter(url => url.protocol === "file:").map(url => fileURLToPath(url))),
			content: css,
		};
	}

	async writeTo(dist: string): Promise<void> {
		const es3Outputs = new Set(
			[...this.es3.sources].map(source =>
				path.relative(dist, es3OutputPath(this.webroot.config.webroot, dist, source))
			),
		);
		const files = new Map<string, string | Uint8Array>();
		for (const pending of this.bundles.values()) {
			for (const [filename, contents] of (await pending).files) {
				if (es3Outputs.has(filename)) throw new Error(`JS and ES3 both produce ${filename}`);
				const previous = files.get(filename);
				if (previous !== undefined && !Buffer.from(previous).equals(Buffer.from(contents))) {
					throw new Error(`JS output collision: ${filename}`);
				}
				files.set(filename, contents);
			}
		}
		for (const [filename, contents] of files) {
			const destination = path.join(dist, filename);
			fs.mkdirSync(path.dirname(destination), { recursive: true });
			fs.writeFileSync(destination, contents);
		}
	}

	plugin(): vite.Plugin {
		let server: vite.ViteDevServer | undefined;
		let queue = Promise.resolve();
		return {
			name: "astralhp:bundles",
			enforce: "pre",
			configureServer: devServer => {
				server = devServer;
				server.watcher.on("all", (event, filename) => {
					if (!["add", "change", "unlink"].includes(event) || filename.includes(`${path.sep}.caches${path.sep}`)) {
						return;
					}
					queue = queue.then(async () => {
						let changed = false;
						for (const [source, pending] of [...this.bundles]) {
							if (!(await pending).dependencies.has(filename)) continue;
							this.bundles.delete(source);
							try {
								await this.bundle(source);
							} catch (error) {
								// Keep watching the last successful dependency graph so a
								// syntax error can be repaired without restarting dev.
								this.bundles.set(source, pending);
								throw error;
							}
							changed = true;
						}
						if (!changed) return;
						await this.writeTo(this.webroot.dist);
						for (const environment of Object.values(server!.environments)) environment.moduleGraph.invalidateAll();
						server!.ws.send({ type: "full-reload", path: "*" });
					}).catch(error => {
						server!.config.logger.error(`AstralHP asset: ${error.message}`);
						server!.ws.send({ type: "error", err: { message: error.message, stack: error.stack } });
					});
				});
			},
			transform: {
				order: "pre",
				handler: async (code, id) => {
					if (!id.endsWith(".astro")) return;
					const scripts = assetReferences(this.webroot, id, code, "JS").assets;
					const styles = assetReferences(this.webroot, id, code, "CSS").assets;
					if (!scripts.length && !styles.length) return;
					await queue;
					const output = new MagicString(code);
					for (const reference of scripts) {
						const bundle = await this.bundle(reference.source);
						output.overwrite(reference.start, reference.end, `{${JSON.stringify(bundle.src)}}`);
						output.appendLeft(reference.insert, ` __astralhpStyles={${JSON.stringify(bundle.styles)}}`);
						if (reference.mayInline) {
							const pathname = bundle.src.split("?")[0]!;
							const content = inlineJS(bundle.content, pathname);
							const inlineStyles = bundle.styles.map(href => {
								const css = bundle.files.get(decodeURIComponent(href.slice(1)).split("/").join(path.sep))!;
								return inlineCSS(Buffer.from(css).toString(), href);
							});
							output.appendLeft(
								reference.insert,
								` __astralhpContent={${JSON.stringify(content)}} __astralhpInlineStyles={${
									JSON.stringify(inlineStyles)
								}}`,
							);
						}
						server?.watcher.add([...bundle.dependencies]);
					}
					for (const reference of styles) {
						output.overwrite(reference.start, reference.end, `{${JSON.stringify(reference.pathname)}}`);
						if (reference.source.endsWith(".scss") || reference.mayInline) {
							const bundle = await this.bundle(reference.source);
							output.appendLeft(reference.insert, ` __astralhpHref={${JSON.stringify(bundle.src)}}`);
							if (reference.mayInline) {
								const content = inlineCSS(bundle.content, bundle.src.split("?")[0]!);
								output.appendLeft(reference.insert, ` __astralhpContent={${JSON.stringify(content)}}`);
							}
							server?.watcher.add([...bundle.dependencies]);
						} else {
							const entry = path.relative(this.webroot.config.webroot, reference.source);
							const owner = this.owners.get(entry);
							if (owner && owner !== reference.source) {
								throw new Error(`Asset output collision: ${owner} and ${reference.source} both use ${entry}`);
							}
							this.owners.set(entry, reference.source);
						}
					}
					if (server) await this.writeTo(this.webroot.dist);
					return {
						code: output.toString(),
						map: output.generateMap({ hires: true, source: id, includeContent: true }).toString(),
					};
				},
			},
		};
	}
}
