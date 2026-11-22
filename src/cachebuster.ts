import fs from "node:fs";
import { contentHash } from "./utils.js";
import type { Webroot } from "./webroot.js";

function cachebustFile(
	webroot: Webroot,
	source: string,
	base: URL,
	dist: boolean,
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

	const lookup = webroot.lookup(resolved, { dist });
	if (lookup.kind !== "file") {
		throw new Error(`Cachebusted asset does not exist in the webroot: ${source}`);
	}

	return `${source}?v=${contentHash(fs.readFileSync(lookup.filename))}`;
}

export function cachebust(webroot: Webroot, source: string, base: URL): string {
	return cachebustFile(webroot, source, base, false);
}

export function cachebustES3Script(webroot: Webroot, source: string, base: URL): string {
	return cachebustFile(webroot, source.replace(/\.tsx?$/i, ".js"), base, true);
}
