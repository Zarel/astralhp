import { parseSync, traverse, type types } from "@babel/core";
import { generate, parse, walk } from "css-tree";
import MagicString from "magic-string";

// Inline assets resolve URLs against their original asset location, not the page.
function assetURL(value: string, pathname: string): string {
	if (/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(value) || !value) return value;
	const url = new URL(value, `https://astralhp.invalid${pathname}`);
	return url.pathname + url.search + url.hash;
}

export function inlineCSS(code: string, pathname: string): string {
	const output = new MagicString(code);
	const ast = parse(code, {
		positions: true,
		parseCustomProperty: true,
		onComment(value, loc) {
			if (/^#\s*sourceMappingURL=/.test(value)) output.remove(loc.start.offset, loc.end.offset);
		},
	});
	walk(ast, function(node) {
		const importString = node.type === "String" && this.atrule?.name.toLowerCase() === "import" &&
			this.atrule.prelude?.type === "AtrulePrelude" && this.atrule.prelude.children.first === node;
		const imageString = node.type === "String" && /^(?:-webkit-)?image-set$/i.test(this.function?.name ?? "");
		if (node.type !== "Url" && !importString && !imageString) return;
		if (node.type !== "Url" && node.type !== "String") return;
		const value = assetURL(node.value, pathname);
		if (value !== node.value && node.loc) {
			output.overwrite(node.loc.start.offset, node.loc.end.offset, generate({ ...node, value }));
		}
	});
	return output.toString().replace(/<\/style/gi, match => "\\3c " + match.slice(1));
}

export function inlineJS(code: string, pathname: string): string {
	const output = new MagicString(code);
	const ast = parseSync(code, { babelrc: false, configFile: false, sourceType: "module" });
	if (!ast) throw new Error(`Unable to parse JS bundle: ${pathname}`);
	const rewriteSource = (node: types.Node | null | undefined): void => {
		const value = node?.type === "StringLiteral" ?
			node.value :
			node?.type === "TemplateLiteral" && !node.expressions.length ?
			node.quasis[0]?.value.cooked :
			undefined;
		if (!value || !/^\.\.?\//.test(value)) return;
		output.overwrite(node!.start!, node!.end!, JSON.stringify(assetURL(value, pathname)));
	};
	traverse(ast, {
		ImportDeclaration({ node }) {
			rewriteSource(node.source);
		},
		ExportNamedDeclaration({ node }) {
			rewriteSource(node.source);
		},
		ExportAllDeclaration({ node }) {
			rewriteSource(node.source);
		},
		ImportExpression({ node }) {
			rewriteSource(node.source);
		},
		CallExpression({ node }) {
			if (node.callee.type === "Import") rewriteSource(node.arguments[0]);
		},
		MemberExpression({ node }) {
			if (
				node.object.type === "MetaProperty" && node.object.meta.name === "import" &&
				(node.computed ?
					node.property.type === "StringLiteral" && node.property.value === "url" :
					node.property.type === "Identifier" && node.property.name === "url")
			) {
				output.overwrite(node.start!, node.end!, `new URL(${JSON.stringify(pathname)},document.baseURI).href`);
			}
		},
	});
	for (const comment of ast.comments ?? []) {
		if (/^[#@]\s*sourceMappingURL=/.test(comment.value.trim())) output.remove(comment.start!, comment.end!);
	}
	// HTML parses raw script text before JavaScript strings, comments, or regexps.
	return output.toString().replace(/<(?=\/script|script|!--)/gi, "\\u003c");
}
