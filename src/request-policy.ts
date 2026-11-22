const markdownSuffix = ".md";
const componentSuffixes = [".astro", ".mdx"];
const endpointSuffixes = [".astro.js", ".astro.ts"];
export const includeSuffixes = [".inc.astro", ".inc.ts", ".inc.js"] as const;
export const routeSuffixes: readonly string[] = [markdownSuffix, ...componentSuffixes, ...endpointSuffixes];

function suffixPattern(suffixes: readonly string[]): RegExp {
	return new RegExp(`(?:${suffixes.map(suffix => suffix.replaceAll(".", "\\.")).join("|")})$`, "i");
}

export const privatePath: RegExp = /(?:^|\/)(?:node_modules(?:\/|$)|\.(?!well-known(?:\/|$)))/i;
const componentSource = suffixPattern(componentSuffixes);
export const includeSource: RegExp = suffixPattern(includeSuffixes);
const privateSource = suffixPattern([...endpointSuffixes, ...includeSuffixes]);
const sourceSuffix = suffixPattern([
	markdownSuffix, ".ts", ".tsx", ".cts", ".ctsx", ".mts", ".mtsx", ".jsx", ".scss", ".map",
]);
export const unminifiedJS: RegExp = /(?<!\.min)\.[cm]?js$/i;

export function blockedPatterns(serveSourceFiles: boolean): RegExp[] {
	const patterns = [privatePath, componentSource, privateSource];
	if (!serveSourceFiles) patterns.push(sourceSuffix);
	return patterns;
}

export function parsePath(requestUrl: string | URL | undefined): { parts: string[]; directoryIndex: boolean } | null {
	if (!requestUrl) return null;
	const url = typeof requestUrl === "string" ? URL.parse(requestUrl, "http://astralhp.local") : requestUrl;
	if (!url) return null;
	try {
		const pathname = decodeURIComponent(url.pathname);
		if (privatePath.test(pathname)) return null;
		return { parts: pathname.split("/").filter(Boolean), directoryIndex: url.pathname.endsWith("/") };
	} catch {
		return null;
	}
}

/** A null result continues to filesystem lookup. */
export function classifyRequest(parts: string[], serveSourceFiles: boolean): "private" | "miss" | null {
	const name = parts.at(-1) ?? "";
	if (privateSource.test(name)) return "private";
	if (componentSource.test(name)) return "miss";
	if (!serveSourceFiles && (sourceSuffix.test(name) || (parts[0] === "@fs" && unminifiedJS.test(name)))) {
		return "private";
	}
	return null;
}

export function allowsResolvedFile(relativePath: string, serveSourceFiles: boolean): boolean {
	return !privatePath.test(relativePath) && !privateSource.test(relativePath) && !componentSource.test(relativePath) &&
		(serveSourceFiles || !sourceSuffix.test(relativePath));
}

export function hidesOriginal(filename: string, requestName: string, serveSourceFiles: boolean): boolean {
	return !serveSourceFiles &&
		(sourceSuffix.test(filename) || unminifiedJS.test(filename) || unminifiedJS.test(requestName));
}
