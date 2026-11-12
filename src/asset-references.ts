import { parse } from "@astrojs/compiler-rs";
import MagicString from "magic-string";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isBabelSource } from "./babel.js";
import type { Webroot } from "./webroot.js";

// The Astro parser exposes its ESTree-compatible AST as Record<string, any>.
type Node = Record<string, any>;

export interface AssetReference {
	source: string;
	start: number;
	end: number;
	insert: number;
	pathname: string;
}

export interface AssetReferences {
	code: string;
	map: ReturnType<MagicString["generateMap"]>;
	sources: string[];
	assets: AssetReference[];
}

export function assetReferences(
	webroot: Webroot,
	filename: string,
	code: string,
	kind: "ES3" | "JS" | "CSS" = "ES3",
): AssetReferences {
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
				(specifier.imported.name ?? specifier.imported.value) === kind
			) names.add(specifier.local.name);
		}
	}
	const output = new MagicString(code);
	const sources = new Set<string>();
	const assets: AssetReference[] = [];
	const bytes = Buffer.from(code);
	// Compiler offsets are UTF-8 bytes; MagicString uses UTF-16 offsets.
	const offset = (byte: number): number => bytes.subarray(0, byte).toString().length;
	const fail = (message: string): never => {
		throw new Error(`${filename}: <${kind}> ${message}`);
	};
	function visit(node: Node): void {
		if (node.type === "JSXOpeningElement") {
			const name = node.name;
			const matches = name.type === "JSXIdentifier" ?
				names.has(name.name) :
				name.type === "JSXMemberExpression" && namespaces.has(name.object.name) && name.property.name === kind;
			if (matches) {
				const attributes: Node[] = node.attributes;
				const srcs = attributes.filter(attr => attr.type === "JSXAttribute" && attr.name.name === "src");
				const src = srcs[0];
				if (srcs.length !== 1 || src?.value?.type !== "Literal" || typeof src.value.value !== "string") {
					fail(`requires a literal src, such as src="${kind === "CSS" ? "/style.scss" : "/js/app.ts"}"`);
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
				if (kind === "CSS") {
					if (!/\.(?:css|scss)$/.test(target!)) fail("src must reference a .css or .scss file");
					sources.add(target!);
				} else if (kind === "JS" && /\.(?:[cm]?js|jsx|tsx?)$/.test(target!) && !target!.endsWith(".d.ts")) {
					sources.add(target!);
				} else if (isBabelSource(target!)) sources.add(target!);
				else if (!/\.m?js$/.test(target!)) fail("src must reference a .ts, .tsx, .js, or .mjs file");
				assets.push({
					source: target!,
					start: offset(src!.value.start),
					end: offset(src!.value.end),
					insert: offset(node.name.end),
					pathname: url.pathname,
				});
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
		assets,
	};
}
