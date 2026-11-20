declare module "virtual:astralhp/markdown-pages" {
	const pages: Record<string, () => Promise<Pick<typeof import("*.md"), "Content">>>;
	export default pages;
}
