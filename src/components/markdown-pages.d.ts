declare module "virtual:astralhp/markdown-pages" {
	const pages: Record<string, () => Promise<typeof import("*.md")>>;
	export default pages;
}
