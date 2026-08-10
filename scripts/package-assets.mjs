import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const source = path.join(root, "src");
const dist = path.join(root, "dist");

function clean() {
	fs.rmSync(dist, { force: true, recursive: true });
}

function compiledAstro(sourceCode) {
	return sourceCode
		.replace(/(\bfrom\s+["']\.\.?\/[^"']+)\.ts(["'])/g, "$1.js$2")
		.replace(/(\bimport\s+["']\.\.?\/[^"']+)\.ts(["'])/g, "$1.js$2");
}

function copyMatching(directory, matches, transform) {
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		const sourceFile = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			copyMatching(sourceFile, matches, transform);
			continue;
		}
		if (!entry.isFile() || !matches(sourceFile)) continue;

		const distFile = path.join(dist, path.relative(source, sourceFile));
		fs.mkdirSync(path.dirname(distFile), { recursive: true });
		if (transform) {
			fs.writeFileSync(distFile, transform(fs.readFileSync(sourceFile, "utf8")));
		} else {
			fs.copyFileSync(sourceFile, distFile);
		}
		if (sourceFile.endsWith(".d.ts")) {
			fs.rmSync(`${distFile}.map`, { force: true });
		}
	}
}

function copy() {
	copyMatching(source, file => file.endsWith(".d.ts"));
	fs.copyFileSync(path.join(source, "mime.types"), path.join(dist, "mime.types"));
	copyMatching(
		path.join(source, "components"),
		file => file.endsWith(".astro"),
		compiledAstro,
	);
}

switch (process.argv[2]) {
	case "clean":
		clean();
		break;
	case "copy":
		copy();
		break;
	default:
		throw new Error("Expected package-assets.mjs clean or copy");
}
