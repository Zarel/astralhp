import * as babel from "@babel/core";
import fs from "node:fs";
import path from "node:path";
import type * as vite from "vite";
import type { WebrootPaths } from "./webroot.ts";

const ASTROHP_ROOT = path.resolve(import.meta.dirname, "..");
const PRIVATE_DIRECTORIES = new Set(["caches", "node_modules"]);

const SHOWDOWN_BABEL_OPTIONS: babel.TransformOptions = {
	babelrc: false,
	configFile: false,
	plugins: [
		// TypeScript + JSX
		["@babel/plugin-transform-typescript", { isTSX: true, allowDeclareFields: true }],
		["@babel/plugin-transform-react-jsx", { pragma: "preact.h", pragmaFrag: "preact.Fragment", useBuiltIns: true }],
		["@babel/plugin-transform-class-properties", { loose: true }],

		// ESNext
		"remove-import-export",
		"@babel/plugin-transform-logical-assignment-operators",
		["@babel/plugin-transform-nullish-coalescing-operator", { loose: true }],
		["@babel/plugin-transform-optional-chaining", { loose: true }],
		["@babel/plugin-transform-object-rest-spread", { loose: true, useBuiltIns: true }],
		"@babel/plugin-transform-optional-catch-binding",
		"@babel/plugin-transform-exponentiation-operator",

		// ES6
		"@babel/plugin-transform-arrow-functions",
		["@babel/plugin-transform-block-scoping", { throwIfClosureRequired: true }],
		["@babel/plugin-transform-classes", { loose: true }],
		["@babel/plugin-transform-computed-properties", { loose: true }],
		["@babel/plugin-transform-destructuring", { loose: true, useBuiltIns: true }],
		["@babel/plugin-transform-for-of", { assumeArray: true }],
		"@babel/plugin-transform-literals",
		"@babel/plugin-transform-parameters",
		"@babel/plugin-transform-shorthand-properties",
		["@babel/plugin-transform-spread", { loose: true }],
		["@babel/plugin-transform-template-literals", { loose: true }],

		// ES3
		"@babel/plugin-transform-member-expression-literals",
		"@babel/plugin-transform-property-literals",

		"@babel/plugin-transform-strict-mode",
	],
	compact: true,
	comments: false,
	retainLines: true,
	sourceMaps: true,
};

export function isBabelSource(filename: string): boolean {
	return (
		(filename.endsWith(".ts") || filename.endsWith(".tsx")) &&
		!filename.endsWith(".d.ts")
	);
}

export function scriptOutputPath(
	webroot: string,
	buildRoot: string,
	source: string,
): string {
	const relative = path.relative(webroot, source);
	if (
		relative === ".." || relative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relative) || !isBabelSource(relative)
	) {
		throw new Error(`Not a TypeScript source in the webroot: ${source}`);
	}
	return path.join(buildRoot, relative.replace(/\.tsx?$/, ".js"));
}

export function scanBabelSources(webroot: string): string[] {
	const sources: string[] = [];

	function scan(directory: string) {
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			if (entry.name.startsWith(".")) continue;
			const filename = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				if (!PRIVATE_DIRECTORIES.has(entry.name.toLowerCase())) scan(filename);
			} else if (entry.isFile() && isBabelSource(filename)) {
				sources.push(filename);
			}
		}
	}

	scan(path.resolve(webroot));
	return sources.sort();
}

function sourceMapComment(filename: string): string {
	return `\n//# sourceMappingURL=${path.basename(filename)}.map`;
}

function writeCompiledFile(
	source: string,
	output: string,
	result: babel.BabelFileResult,
): void {
	if (result.code === null || result.code === undefined) return;
	fs.mkdirSync(path.dirname(output), { recursive: true });

	let code = result.code;
	if (result.map) {
		const mapFile = `${output}.map`;
		result.map.file = path.basename(output);
		fs.writeFileSync(mapFile, JSON.stringify(result.map));
		if (!code.includes("sourceMappingURL=")) code += sourceMapComment(output);
	} else {
		fs.rmSync(`${output}.map`, { force: true });
	}

	fs.writeFileSync(output, code);
	fs.chmodSync(output, fs.statSync(source).mode);
}

export async function compileScript(
	paths: Pick<WebrootPaths, "webroot" | "build">,
	source: string,
): Promise<string | null> {
	const output = scriptOutputPath(paths.webroot, paths.build, source);

	const result = await babel.transformFileAsync(source, {
		...SHOWDOWN_BABEL_OPTIONS,
		cwd: ASTROHP_ROOT,
		sourceFileName: path
			.relative(path.dirname(output), source)
			.split(path.sep)
			.join("/"),
	});
	if (!result) {
		fs.rmSync(output, { force: true });
		fs.rmSync(`${output}.map`, { force: true });
		return null;
	}

	writeCompiledFile(source, output, result);
	return output;
}

export async function compileScripts(
	paths: Pick<WebrootPaths, "webroot" | "build">,
): Promise<string[]> {
	const sources = scanBabelSources(paths.webroot);
	if (!sources.length) return [];

	const outputs = await Promise.all(
		sources.map(source => compileScript(paths, source)),
	);
	return outputs.filter(output => output !== null);
}

function removeCompiledScript(
	paths: Pick<WebrootPaths, "webroot" | "build">,
	source: string,
): void {
	const output = scriptOutputPath(paths.webroot, paths.build, source);
	fs.rmSync(output, { force: true });
	fs.rmSync(`${output}.map`, { force: true });
}

export function babelWatcher(paths: WebrootPaths): vite.Plugin {
	const knownSources = new Set(scanBabelSources(paths.webroot));
	let queue = Promise.resolve();

	return {
		name: "astrohp:babel",
		configureServer(server) {
			server.watcher.add(paths.webroot);
			server.watcher.on("all", (event, filename) => {
				if (!isBabelSource(filename)) return;

				if (event === "add" && knownSources.has(filename)) return;
				if (event !== "add" && event !== "change" && event !== "unlink") return;

				queue = queue.then(async () => {
					try {
						if (event === "unlink") {
							knownSources.delete(filename);
							removeCompiledScript(paths, filename);
						} else {
							knownSources.add(filename);
							await compileScript(paths, filename);
						}
						server.ws.send({ type: "full-reload", path: "*" });
					} catch (error) {
						server.config.logger.error(
							`AstroHP Babel: ${(error as Error).message}`,
							{ error: error as Error },
						);
					}
				});
			});
		},
	};
}
