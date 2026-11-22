export type Adapter = "node" | "apache-proxy" | "apache-cgi" | "apache-static";

export interface WebrootConfig {
	/**
	 * Which directory to use as AstralHP's webroot, relative to the config
	 * file.
	 *
	 * @default '.'
	 */
	webroot?: string;
	/** Files or directories to skip during page discovery, relative to the webroot. */
	excludePages?: readonly string[];
	/**
	 * Serve `.md`, `.ts`, `.scss`, `.js.map` etc files over HTTP. Defaults to true.
	 * Note that `.astro` and `.mdx` sources will never be served.
	 */
	serveSourceFiles?: boolean;
	/** Add `target="blank" rel="noopener"` to external Markdown links. Defaults to false. */
	markdownAddTargetBlank?: boolean;
	/** Default Astro layout for `.md` and `.mdx` pages, relative to the config file. */
	markdownLayout?: string | undefined;
	/**
	 * Whether pages are rendered at build time by default. A page's
	 * `export const prerender` overrides this setting.
	 *
	 * @default true
	 */
	prerender?: boolean;
	/**
	 * Which adapter to use.
	 *
	 * - `node` - use Astro's Node adapter server for everything
	 * - `apache-proxy` - use Apache to serve static files, proxying Astro's
	 *   Node server for dynamic routes
	 * - `apache-cgi` - use Apache for static files and CGI for dynamic routes
	 * - `apache-static` - prerender all pages for Apache; dynamic routes are errors
	 *
	 * @default 'apache-static'
	 */
	adapter?: Adapter;
	/**
	 * Absolute path to the JavaScript interpreter (Bun or Node) for apache-cgi.
	 * Must not contain whitespace. Defaults to finding bun on Apache's PATH.
	 */
	runtimePath?: string | undefined;
	/**
	 * Port for the AstralHP server. `apache-proxy` webroots with the same port
	 * share one listener in the same process. Each `node` webroot must use a
	 * different port. With `apache-proxy`, the port only serves dynamic routes
	 * and is proxied by Apache.
	 *
	 * @default 4321
	 */
	port?: number;
}

/** Configure one webroot, or several sharing defaults with per-webroot overrides. */
export type Config =
	WebrootConfig |
	(Omit<WebrootConfig, "webroot"> & {
		/**
		 * Paths relative to this config file, or per-webroot overrides.
		 * Entries inherit the top-level settings.
		 */
		webroot: readonly (string | (WebrootConfig & { webroot: string }))[];
	});
