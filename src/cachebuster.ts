import fs from "node:fs";
import { resolveStaticFile, resolveWebrootFile } from "./webroot.ts";

function cachebustFile(
	webroot: string,
	source: string,
	base: URL,
	resolveFile: typeof resolveWebrootFile,
): string {
	if (
		!source || source.startsWith("//") || source.includes("\\") ||
		/^[a-z][a-z\d+.-]*:/i.test(source)
	) {
		throw new Error(`Cachebusted assets must use a relative or root-relative URL: ${source}`);
	}
	if (source.includes("?") || source.includes("#")) {
		throw new Error(`Cachebusted assets must not contain a query or fragment: ${source}`);
	}

	const resolved = new URL(source, base);
	if (resolved.origin !== base.origin) {
		throw new Error(`Cachebusted assets must use a relative or root-relative URL: ${source}`);
	}

	const filename = resolveFile(webroot, resolved.pathname);
	if (!filename) {
		throw new Error(`Cachebusted asset does not exist in the webroot: ${source}`);
	}

	const mtime = Math.trunc(fs.statSync(filename).mtimeMs).toString(36);
	return `${source}?${mtime}`;
}

export function cachebust(webroot: string, source: string, base: URL): string {
	return cachebustFile(webroot, source, base, resolveStaticFile);
}

export function cachebustScript(webroot: string, source: string, base: URL): string {
	const typescript = /\.tsx?$/i.test(new URL(source, base).pathname);
	const cachebusted = cachebustFile(
		webroot,
		source,
		base,
		typescript ? resolveWebrootFile : resolveStaticFile,
	);
	return cachebusted.replace(/\.tsx?(?=\?)/i, ".js");
}
