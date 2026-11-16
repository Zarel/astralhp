/** @jsx h */

declare global {
	namespace JSX {
		type IntrinsicElements = Record<any, any>;
	}
}

function h(
	tag: string,
	attributes: Record<string, unknown> | null,
	...children: (Node | string)[]
) {
	const element = document.createElement(tag);
	if (attributes) Object.assign(element, attributes);
	element.append(...children);
	return element;
}

document.body.appendChild(<div>Hello from AstralHP</div>);

export const THIS_IS_A_GLOBAL = true;
