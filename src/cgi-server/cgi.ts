/**
 * CGI entry point. The build process will add a hashbang
 * corresponding to the `runtimePath` config setting.
 */

import { runCGI } from "./cgi-runtime.js";

try {
	await runCGI(() => import("./app.js"));
} catch (error) {
	console.error(error);
	process.exit(1);
}
process.exit(0);
