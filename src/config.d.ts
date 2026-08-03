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
	 * Port for the AstroHP server. `apache-proxy` webroots with the same port
	 * share one listener in the same process. Each `node` webroot must use a
	 * different port. With `apache-proxy`, the port only serves dynamic routes
	 * and is proxied by Apache.
	 *
	 * @default 4321
	 */
	port?: number;
}
