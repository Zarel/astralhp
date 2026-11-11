import { parse } from "@astrojs/compiler-rs";
import MagicString from "magic-string";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type * as vite from "vite";
import { compileScript, isBabelSource, scriptOutputPath } from "./babel.js";
import type { Webroot } from "./webroot.js";

// The Astro parser exposes its ESTree-compatible AST as Record<string, any>.
type Node = Record<string, any>;

export interface ES3References {
	code: string;
	map: ReturnType<MagicString["generateMap"]>;
	sources: string[];
}

export function es3References(webroot: Webroot, filename: string, code: string): ES3References {
	const { ast } = parse(code);
	const names = new Set<string>();
	const namespaces = new Set<string>();
	for (const node of ast.frontmatter?.program.body ?? []) {
		if (node.type !== "ImportDeclaration" || node.source.value !== "astrohp/components" || node.importKind === "type") {
			continue;
		}
		for (const specifier of node.specifiers) {
			if (specifier.type === "ImportNamespaceSpecifier") namespaces.add(specifier.local.name);
			if (
				specifier.type === "ImportSpecifier" && specifier.importKind !== "type" &&
				(specifier.imported.name ?? specifier.imported.value) === "ES3"
			) names.add(specifier.local.name);
		}
	}
	const output = new MagicString(code);
	const sources = new Set<string>();
	const bytes = Buffer.from(code);
	// Compiler offsets are UTF-8 bytes; MagicString uses UTF-16 offsets.
	const offset = (byte: number): number => bytes.subarray(0, byte).toString().length;
	const fail = (message: string): never => {
		throw new Error(`${filename}: <ES3> ${message}`);
	};
	function visit(node: Node): void {
		if (node.type === "JSXOpeningElement") {
			const name = node.name;
			const legacy = name.type === "JSXIdentifier" ?
				names.has(name.name) :
				name.type === "JSXMemberExpression" && namespaces.has(name.object.name) && name.property.name === "ES3";
			if (legacy) {
				const attributes: Node[] = node.attributes;
				const srcs = attributes.filter(attr => attr.type === "JSXAttribute" && attr.name.name === "src");
				const src = srcs[0];
				if (srcs.length !== 1 || src?.value?.type !== "Literal" || typeof src.value.value !== "string") {
					fail('requires a literal src, such as src="/js/app.ts"');
				}
				// A spread after src could override the statically registered source.
				if (attributes.slice(attributes.indexOf(src!) + 1).some(attr => attr.type === "JSXSpreadAttribute")) {
					fail("requires attribute spreads to appear before src");
				}
				const source: string = src!.value.value;
				if (!source || source.startsWith("//") || /[\\?#]|^[a-z][a-z\d+.-]*:/i.test(source)) {
					fail("src must be a local path without a query or fragment");
				}
				let pathname = source;
				if (!source.startsWith("/")) {
					const resolved = fileURLToPath(new URL(source, pathToFileURL(filename)));
					const relative = path.relative(webroot.path, resolved);
					if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
						fail(`source must be inside the webroot: ${source}`);
					}
					pathname = "/" + relative.split(path.sep).map(encodeURIComponent).join("/");
				}
				const url = new URL(pathname, "http://astrohp.local/");
				const target = webroot.resolveFile(url.pathname);
				if (!target) fail(`source does not exist inside the webroot: ${source}`);
				if (isBabelSource(target!)) sources.add(target!);
				else if (!/\.m?js$/.test(target!)) fail("src must reference a .ts, .tsx, .js, or .mjs file");
				output.overwrite(offset(src!.value.start), offset(src!.value.end), `{${JSON.stringify(url.pathname)}}`);
			}
		}
		for (const value of Object.values(node)) {
			if (Array.isArray(value)) {
				for (const child of value) if (child && typeof child === "object") visit(child);
			} else if (value && typeof value === "object") visit(value);
		}
	}
	for (const node of ast.body) visit(node);
	return {
		code: output.toString(),
		map: output.generateMap({ hires: true, source: filename, includeContent: true }),
		sources: [...sources],
	};
}

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
				const result = es3References(webroot, id, code);
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
