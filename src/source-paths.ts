import { parseSync, types } from "@babel/core";
import MagicString from "magic-string";
import path from "node:path";
import type * as vite from "vite";
import type { Webroot } from "./webroot.js";

function rewriteImportMeta(code: string, replace: (property: string) => string | undefined) {
	const ast = parseSync(code, { babelrc: false, configFile: false, sourceType: "module" });
	if (!ast) return;
	const output = new MagicString(code);
	types.traverseFast(ast, node => {
		if (!types.isMemberExpression(node) && !types.isOptionalMemberExpression(node)) return;
		if (!types.isMetaProperty(node.object) || node.object.meta.name !== "import") return;
		const property = node.computed && types.isStringLiteral(node.property) ? node.property.value :
			!node.computed && types.isIdentifier(node.property) ? node.property.name : undefined;
		const replacement = property && replace(property);
		if (replacement) output.overwrite(node.start!, node.end!, replacement);
	});
	if (output.hasChanged()) return { code: output.toString(), map: output.generateMap({ hires: true }) };
}

export function sourcePathsPlugin(webroot: Webroot): vite.Plugin {
	// Keep the source directory attached to each use until the bundler assigns it a chunk.
	const prefix = "__astralhp_dirname_";
	const directories = new Map<string, string>();
	const roots = [webroot.projectDir, webroot.path].map(root => path.join(root, path.sep));
	return {
		name: "astralhp:source-paths",
		apply: "build",
		applyToEnvironment: env => env.config.consumer === "server",
		enforce: "post",
		transform(code, id) {
			if (!code.includes("dirname") && !code.includes("filename")) return;
			const filename = id.split("?")[0]!;
			if (!path.isAbsolute(filename)) return;
			const normalized = path.normalize(filename);
			if (!roots.some(root => normalized.startsWith(root)) || normalized.split(path.sep).includes("node_modules")) {
				return;
			}
			const marker = prefix + directories.size;
			const directory = `import.meta.${marker}`;
			const result = rewriteImportMeta(code, property => {
				if (property === "dirname") return directory;
				if (property === "filename") return `(${directory} + ${JSON.stringify("/" + path.basename(filename))})`;
			});
			if (result) directories.set(marker, path.dirname(filename));
			return result;
		},
		renderChunk(code, chunk, options) {
			if (!code.includes(prefix)) return;
			const chunkDir = path.resolve(options.dir!, path.dirname(chunk.fileName));
			return rewriteImportMeta(code, property => {
				const directory = directories.get(property);
				if (!directory) return;
				const relative = path.relative(chunkDir, directory).split(path.sep).join("/");
				return relative ? `(import.meta.dirname + ${JSON.stringify("/" + relative)})` : "import.meta.dirname";
			});
		},
	};
}
