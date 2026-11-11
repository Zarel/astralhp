import * as babel from "@babel/core";
import fs from "node:fs";
import path from "node:path";
import type { Webroot } from "./webroot.js";

const ASTROHP_ROOT = path.resolve(import.meta.dirname, "..");

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
	distRoot: string,
	source: string,
): string {
	const relative = path.relative(webroot, source);
	if (
		relative === ".." || relative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relative) || !isBabelSource(relative)
	) {
		throw new Error(`Not a TypeScript source in the webroot: ${source}`);
	}
	return path.join(distRoot, relative.replace(/\.tsx?$/, ".js"));
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
	webroot: Webroot,
	source: string,
	dist: string = webroot.dist,
): Promise<string | null> {
	const output = scriptOutputPath(webroot.path, dist, source);

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
	webroot: Webroot,
	sources: Iterable<string>,
	dist: string = webroot.dist,
): Promise<string[]> {
	const outputs = await Promise.all(
		[...new Set(sources)].map(source => compileScript(webroot, source, dist)),
	);
	return outputs.filter(output => output !== null);
}
