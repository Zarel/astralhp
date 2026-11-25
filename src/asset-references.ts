import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type AstroNode, AstroTemplate } from "./astro-template.js";
import { isES3Source } from "./es3-compiler.js";
import { isPathInside, publicURL } from "./utils.js";
import type { Webroot } from "./webroot.js";

export interface AssetReference {
	source: string;
	start: number;
	end: number;
	insert: number;
	pathname: string;
	mayInline: boolean;
	body?: string;
}

export interface AssetReferences {
	sources: string[];
	assets: AssetReference[];
}

export function assetReferences(
	webroot: Webroot,
	filename: string,
	code: string,
	kind: "ES3" | "JS" | "CSS" = "ES3",
): AssetReferences {
	const { frontmatter, elements, offset } = new AstroTemplate(code);
	const names = new Set<string>();
	const namespaces = new Set<string>();
	for (const node of frontmatter?.program.body ?? []) {
		if (
			node.type !== "ImportDeclaration" || node.source.value !== "astralhp/components" || node.importKind === "type"
		) {
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
	const sources = new Set<string>();
	const assets: AssetReference[] = [];
	const fail = (message: string): never => {
		throw new Error(`${filename}: <${kind}> ${message}`);
	};
	for (const { openingElement: node } of elements) {
		const name = node.name;
		const matches = name.type === "JSXIdentifier" ?
			names.has(name.name) :
			name.type === "JSXMemberExpression" && namespaces.has(name.object.name) && name.property.name === kind;
		if (!matches) continue;
		const attributes: AstroNode[] = node.attributes;
		const body = kind === "JS" && attributes.find(attr => attr.name?.name === "__astralhpBody");
		if (body) {
			const value = body.value?.expression?.value;
			if (typeof value !== "string") fail("invalid inline script body");
			assets.push({
				source: filename + ".script-" + assets.length + ".ts?astralhp-inline",
				start: offset(body.start),
				end: offset(body.end),
				insert: offset(node.name.end),
				pathname: "",
				mayInline: true,
				body: value,
			});
			continue;
		}
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
			if (!isPathInside(webroot.config.webroot, resolved)) {
				fail(`source must be inside the webroot: ${source}`);
			}
			pathname = publicURL(path.relative(webroot.config.webroot, resolved));
		}
		const url = new URL(pathname, "http://astralhp.local/");
		const target = webroot.resolveFile(url);
		if (!target) fail(`source does not exist inside the webroot: ${source}`);
		if (kind === "CSS") {
			if (!/\.(?:css|scss)$/.test(target!)) fail("src must reference a .css or .scss file");
			sources.add(target!);
		} else if (kind === "JS" && /\.(?:[cm]?js|jsx|tsx?)$/.test(target!) && !target!.endsWith(".d.ts")) {
			sources.add(target!);
		} else if (isES3Source(target!)) sources.add(target!);
		else if (!/\.m?js$/.test(target!)) fail("src must reference a .ts, .tsx, .js, or .mjs file");
		assets.push({
			source: target!,
			start: offset(src!.value.start),
			end: offset(src!.value.end),
			insert: offset(node.name.end),
			pathname: url.pathname,
			mayInline: attributes.some(attr => attr.type === "JSXSpreadAttribute" || attr.name?.name === "inline"),
		});
	}
	return { sources: [...sources], assets };
}
