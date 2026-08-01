export type Adapter = "node" | "apache-proxy";

export interface Config {
	/**
	 * Which directory to use as AstroHP's webroot, relative to the config
	 * file.
	 *
	 * @default '.'
	 */
	webroot?: string;
	/**
	 * Which adapter to use.
	 *
	 * - `node` - use Astro's Node adapter server for everything
	 * - `apache-proxy` - use Apache to serve static files, proxying Astro's
	 *   Node server for dynamic routes
	 *
	 * @default 'node'
	 */
	adapter?: Adapter;
	/**
	 * Port for the Astro Node adapter server. With AstroHP's `node` adapter,
	 * this is the port for the entire server. With `apache-proxy`, this only
	 * serves dynamic routes and is proxied by Apache.
	 *
	 * @default 4321
	 */
	port?: number;
}
