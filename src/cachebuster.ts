import fs from "node:fs";
import { resolveStaticFile } from "./webroot.ts";

export function cachebust(webroot: string, source: string, base: URL): string {
	if (
		!source || source.startsWith("//") || source.includes("\\") ||
		/^[a-z][a-z\d+.-]*:/i.test(source)
	) {
		throw new Error(`Cachebusted assets must use a local or root-relative path: ${source}`);
	}
	if (source.includes("?") || source.includes("#")) {
		throw new Error(`Cachebusted assets must not contain a query or fragment: ${source}`);
	}

	const resolved = new URL(source, base);
	if (resolved.origin !== base.origin) {
		throw new Error(`Cachebusted assets must use a local path: ${source}`);
	}

	const filename = resolveStaticFile(webroot, resolved.pathname);
	if (!filename) {
		throw new Error(`Cachebusted asset does not exist in the webroot: ${source}`);
	}

	const mtime = Math.trunc(fs.statSync(filename).mtimeMs).toString(36);
	return `${source}?${mtime}`;
}
