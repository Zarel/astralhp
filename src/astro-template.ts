import { parse } from "@astrojs/compiler-rs";

// The Astro parser exposes its ESTree-compatible nodes as Record<string, any>.
export type AstroNode = Record<string, any>;

export class AstroTemplate {
	readonly frontmatter: AstroNode | undefined;
	readonly elements: AstroNode[] = [];
	private readonly bytes: Buffer;

	constructor(code: string) {
		const { ast } = parse(code);
		this.bytes = Buffer.from(code);
		this.frontmatter = ast.frontmatter;
		for (const node of ast.body) this.visit(node);
	}

	// Compiler offsets count UTF-8 bytes. String.slice and MagicString use UTF-16.
	offset = (byte: number): number => this.bytes.subarray(0, byte).toString().length;

	private visit(node: AstroNode): void {
		if (node.type === "AstroScript" || node.type === "AstroStyle") return;
		if (node.type === "JSXElement") this.elements.push(node);
		for (const value of Object.values(node)) {
			if (Array.isArray(value)) {
				for (const child of value) if (child && typeof child === "object") this.visit(child);
			} else if (value && typeof value === "object") this.visit(value);
		}
	}
}
