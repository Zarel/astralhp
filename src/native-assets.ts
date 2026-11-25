import MagicString from "magic-string";
import path from "node:path";
import type * as vite from "vite";
import { type AstroNode, AstroTemplate } from "./astro-template.js";
import { compileES3Body } from "./es3-compiler.js";
import { escapeScriptText } from "./inline-assets.js";
import { isPathInside } from "./utils.js";
import type { Webroot } from "./webroot.js";

export function nativeAssetsPlugin(site: Webroot): vite.Plugin {
	return {
		name: "astralhp:native-assets",
		enforce: "pre",
		transform: {
			order: "pre",
			async handler(code, id) {
				if (!id.endsWith(".astro") || !/<(?:script|style)\b/.test(code)) return;
				if (
					id.split(path.sep).includes("node_modules") ||
					![site.projectDir, site.config.webroot].some(root => isPathInside(root, id))
				) return;

				const { frontmatter, elements, offset } = new AstroTemplate(code);
				const output = new MagicString(code);
				let namespace = "AstralHPAssets";
				while (code.includes(namespace)) namespace += "_";
				let needsImport = false;
				function useComponent(node: AstroNode, name: "CSS" | "JS" | "ES3", props = "") {
					const open = node.openingElement;
					needsImport = true;
					output.overwrite(offset(open.name.start), offset(open.name.end), namespace + "." + name);
					output.overwrite(offset(open.end) - (open.selfClosing ? 2 : 1), offset(node.end), props + " />");
				}
				for (const node of elements) {
					const open = node.openingElement;
					const tag = open.name.name;
					if (tag !== "style" && tag !== "script") continue;
					const attrs: AstroNode[] = open.attributes;
					const attr = (name: string) => attrs.find(a => a.name?.name === name);
					const src = attr("src");
					const end = offset(open.end);
					const body = node.closingElement ? code.slice(end, offset(node.closingElement.start)) : "";
					if (tag === "style") {
						if (!src) continue;
						if (body.trim()) throw new Error(id + ": a style cannot have both src and a body");
						useComponent(node, "CSS");
						continue;
					}
					const modes = attrs.filter(a => ["min", "raw", "es3"].includes(a.name?.name?.toLowerCase()));
					const marker = modes[0];
					if (!marker) continue;
					const mode = marker.name.name.toLowerCase();
					if (modes.length > 1 || marker.value) throw new Error(id + ": use a single boolean script mode");
					output.remove(offset(marker.start), offset(marker.end));
					if (mode === "raw") {
						if (!attr("is:inline")) output.appendLeft(offset(open.name.end), " is:inline");
						continue;
					}
					const type = attr("type");
					const nativeType = type &&
						!/^(?:|module|(?:text|application)\/(?:java|ecma)script)$/i.test(type.value?.value ?? "unknown");
					const nativeDirective = attrs.some(a =>
						["is:inline", "define:vars", "set:html", "set:text"].includes(a.name?.name)
					);
					if (nativeType || nativeDirective) {
						throw new Error(id + ": conflicting script mode and type or Astro directive");
					}
					if (src && body.trim()) throw new Error(id + ": a script cannot have both src and a body");
					if (mode === "es3" && type?.value?.value === "module") {
						throw new Error(id + ": ES3 scripts are classic scripts");
					}
					if (!src && mode === "es3") {
						const js = escapeScriptText(await compileES3Body(body, id));
						output.appendLeft(offset(open.name.end), ` is:inline set:html={${JSON.stringify(js)}}`);
						if (body) output.remove(end, offset(node.closingElement.start));
						continue;
					}
					const props = src ? "" : ` inline __astralhpBody={${JSON.stringify(body)}}`;
					useComponent(node, mode === "es3" ? "ES3" : "JS", props);
				}
				if (!output.hasChanged()) return;
				if (needsImport) {
					const statement = `import * as ${namespace} from "astralhp/components";\n`;
					if (frontmatter?.end) output.appendLeft(code.indexOf("\n", offset(frontmatter.start)) + 1, statement);
					else output.prepend(`---\n${statement}---\n`);
				}
				return { code: output.toString(), map: output.generateMap({ hires: true, source: id }) };
			},
		},
	};
}
