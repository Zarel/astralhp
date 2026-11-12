import fs from "node:fs";
import { createHash } from "node:crypto";
import type { Webroot } from "./webroot.js";

export function contentHash(contents: string | Uint8Array): string {
	return createHash("sha256").update(contents).digest("hex").slice(0, 16);
}

function cachebustFile(
	source: string,
	base: URL,
	resolveFile: (requestUrl: string) => string | null,
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

	const filename = resolveFile(resolved.pathname);
	if (!filename) {
		throw new Error(`Cachebusted asset does not exist in the webroot: ${source}`);
	}

	return `${source}?v=${contentHash(fs.readFileSync(filename))}`;
}

export function cachebust(webroot: Webroot, source: string, base: URL): string {
	return cachebustFile(source, base, requestUrl => webroot.resolveStaticFile(requestUrl));
}

export function cachebustScript(webroot: Webroot, source: string, base: URL): string {
	return cachebustFile(
		source.replace(/\.tsx?$/i, ".js"),
		base,
		requestUrl => webroot.resolveDistFile(requestUrl) ?? webroot.resolveStaticFile(requestUrl),
	);
}
