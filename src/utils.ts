import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function contentHash(contents: string | Uint8Array): string {
	return createHash("sha256").update(contents).digest("hex").slice(0, 16);
}

export function publicURL(relativePath: string): string {
	return "/" + relativePath.split(path.sep).map(encodeURIComponent).join("/");
}

export function relativePosixPath(from: string, to: string): string {
	return path.relative(from, to).split(path.sep).join("/");
}

/** Yields the starting directory first and the filesystem root last. */
export function* ancestorDirectories(directory: string): Generator<string> {
	let current = path.resolve(directory);
	while (true) {
		yield current;
		const parent = path.dirname(current);
		if (parent === current) return;
		current = parent;
	}
}

/** Includes the directory itself. Resolve symlinks first when checking their targets. */
export function isPathInside(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function canonicalPath(filename: string): string {
	const absolute = path.resolve(filename);
	try {
		return fs.realpathSync.native(absolute);
	} catch {
		return absolute;
	}
}

export function resolveServerPort(defaultPort = 4321): number {
	const value = process.env.PORT;
	if (value === undefined) return defaultPort;

	const port = Number(value);
	if (!Number.isInteger(port) || port < 0 || port > 65535) {
		throw new Error(`Invalid PORT: ${value}`);
	}
	return port;
}
