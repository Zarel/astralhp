import * as babel from "@babel/core";
import fs from "node:fs";
import path from "node:path";
import { isPathInside, relativePosixPath } from "./utils.js";
import type { Webroot } from "./webroot.js";

const ASTRALHP_ROOT = path.resolve(import.meta.dirname, "..");

const ES3_BABEL_OPTIONS: babel.TransformOptions = {
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

export function isES3Source(filename: string): boolean {
	return (
		(filename.endsWith(".ts") || filename.endsWith(".tsx")) &&
		!filename.endsWith(".d.ts")
	);
}

export function es3OutputPath(
	webroot: string,
	distRoot: string,
	source: string,
): string {
	const relative = path.relative(webroot, source);
	if (!isPathInside(webroot, source) || !isES3Source(relative)) {
		throw new Error(`Not a TypeScript source in the webroot: ${source}`);
	}
	return path.join(distRoot, relative.replace(/\.tsx?$/, ".js"));
}

function sourceMapComment(filename: string): string {
	return `\n//# sourceMappingURL=${path.basename(filename)}.map`;
}

export interface CompiledES3Script {
	code: string;
	map?: string;
}

export function writeCompiledES3Script(
	source: string,
	output: string,
	result: CompiledES3Script | null,
): void {
	if (!result) {
		fs.rmSync(output, { force: true });
		fs.rmSync(`${output}.map`, { force: true });
		return;
	}
	fs.mkdirSync(path.dirname(output), { recursive: true });

	if (result.map) {
		fs.writeFileSync(`${output}.map`, result.map);
	} else {
		fs.rmSync(`${output}.map`, { force: true });
	}

	fs.writeFileSync(output, result.code);
	fs.chmodSync(output, fs.statSync(source).mode);
}

export async function compileES3Body(code: string, filename: string): Promise<string> {
	const result = await babel.transformAsync(code, {
		...ES3_BABEL_OPTIONS,
		cwd: ASTRALHP_ROOT,
		filename: filename + ".tsx",
		sourceMaps: false,
	});
	return result?.code ?? "";
}

export async function prepareES3Script(
	webroot: Webroot,
	source: string,
	dist: string = webroot.dist,
): Promise<CompiledES3Script | null> {
	const output = es3OutputPath(webroot.config.webroot, dist, source);

	const result = await babel.transformFileAsync(source, {
		...ES3_BABEL_OPTIONS,
		cwd: ASTRALHP_ROOT,
		sourceFileName: relativePosixPath(path.dirname(output), source),
	});
	if (result?.code === null || result?.code === undefined) return null;
	let code = result.code;
	if (result.map) {
		result.map.file = path.basename(output);
		if (!code.includes("sourceMappingURL=")) code += sourceMapComment(output);
	}
	return { code, ...(result.map ? { map: JSON.stringify(result.map) } : {}) };
}
