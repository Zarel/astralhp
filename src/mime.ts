import fs from "node:fs";
import path from "node:path";

const MIME_TYPES = loadMimeTypes(
	fs.readFileSync(path.join(import.meta.dirname, "mime.types"), "utf8"),
);

function loadMimeTypes(source: string): ReadonlyMap<string, string> {
	const types = new Map<string, string>();

	for (const sourceLine of source.split(/\r?\n/)) {
		const line = sourceLine.replace(/#.*/, "").trim();
		if (!line) continue;

		const [type, ...extensions] = line.split(/\s+/);
		if (!type) continue; // should never happen
		for (const extension of extensions) {
			types.set(`.${extension.toLowerCase()}`, type);
		}
	}

	return types;
}

export function contentType(filename: string): string {
	return (
		MIME_TYPES.get(path.extname(filename).toLowerCase()) ||
		"application/octet-stream"
	);
}
