/**
 * Converts CGI input to Request, and Response to CGI output.
 */

import { Console } from "node:console";
import { readSync } from "node:fs";
import { STATUS_CODES } from "node:http";

export type CGIHandler = (request: Request, clientAddress?: string) => Promise<Response>;

/** CGI supplies a bounded request body on stdin, not an HTTP message. */
export function cgiRequest(env: NodeJS.ProcessEnv, input: number = 0): Request {
	const method = env.REQUEST_METHOD;
	if (!method) throw new Error("Missing CGI REQUEST_METHOD");
	const protocol = env.HTTPS === "on" || env.HTTPS === "1" ? "https:" : "http:";
	const hostname = env.SERVER_NAME || "localhost";
	const serverHost = hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
	const host = env.HTTP_HOST || `${serverHost}${env.SERVER_PORT ? `:${env.SERVER_PORT}` : ""}`;
	const origin = new URL(`${protocol}//${host}`);
	if (origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
		throw new Error("Invalid CGI host");
	}
	const uri = env.REQUEST_URI || env.SCRIPT_NAME || "/";
	if (!uri.startsWith("/") || /[\r\n#]/.test(uri)) throw new Error("Invalid CGI request URI");
	// Concatenation keeps a leading // in the path from changing the origin.
	const url = new URL(origin.origin + uri.split("?", 1)[0]);
	url.search = env.QUERY_STRING ?? (uri.includes("?") ? uri.slice(uri.indexOf("?") + 1) : "");
	const headers = new Headers();
	for (const [name, value] of Object.entries(env)) {
		if (name.startsWith("HTTP_") && value !== undefined) {
			headers.set(name.slice(5).replaceAll("_", "-"), value);
		}
	}
	// These CGI variables are authoritative; HTTP_CONTENT_* must not override them.
	headers.delete("content-length");
	headers.delete("content-type");
	headers.delete("transfer-encoding");
	if (env.CONTENT_TYPE) headers.set("content-type", env.CONTENT_TYPE);
	const length = env.CONTENT_LENGTH || "0";
	if (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length))) {
		throw new Error("Invalid CGI CONTENT_LENGTH");
	}
	let remaining = Number(length);
	if (env.CONTENT_LENGTH) headers.set("content-length", length);
	const body = remaining > 0 && method !== "GET" && method !== "HEAD" ?
		new ReadableStream<Uint8Array>({
			pull(controller) {
				const chunk = Buffer.allocUnsafe(Math.min(remaining, 65536));
				const count = readSync(input, chunk, 0, chunk.length, null);
				if (!count) throw new Error("Incomplete CGI request body");
				remaining -= count;
				controller.enqueue(chunk.subarray(0, count));
				if (!remaining) controller.close();
			},
		}) :
		null;
	const init: RequestInit & { duplex: "half" } = { method, headers, body, duplex: "half" };
	return new Request(url, init);
}

function write(chunk: string | Uint8Array): Promise<void> {
	return new Promise((resolve, reject) => {
		process.stdout.write(chunk, error => error ? reject(error) : resolve());
	});
}

/** Emit CGI headers (not an HTTP status line) and stream the response bytes. */
export async function writeCGIResponse(response: Response, method: string): Promise<void> {
	let head = `Status: ${response.status} ${STATUS_CODES[response.status] ?? "Response"}\r\n`;
	for (const [name, value] of response.headers) {
		if (["set-cookie", "connection", "transfer-encoding", "keep-alive", "upgrade", "trailer"].includes(name)) continue;
		head += `${name}: ${value}\r\n`;
	}
	for (const cookie of response.headers.getSetCookie()) head += `Set-Cookie: ${cookie}\r\n`;
	if (!response.headers.has("content-type")) head += "Content-Type: application/octet-stream\r\n";
	await write(`${head}\r\n`);
	if (method === "HEAD" || response.status === 204 || response.status === 304) {
		await response.body?.cancel();
		return;
	}
	if (response.body) {
		for await (const chunk of response.body) await write(chunk);
	}
}

export async function runCGI(load: () => Promise<{ handler: CGIHandler }>): Promise<void> {
	// CGI maps the client's Proxy header to HTTP_PROXY. Never let that configure
	// the runtime's outgoing requests (httpoxy).
	delete process.env.HTTP_PROXY;
	// App imports and render-time console output belong in Apache's error log.
	globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });
	let request: Request;
	try {
		request = cgiRequest(process.env);
	} catch (error) {
		console.error(error);
		await writeCGIResponse(new Response("Bad Request", { status: 400 }), process.env.REQUEST_METHOD || "GET");
		return;
	}
	let response: Response;
	try {
		const { handler } = await load();
		response = await handler(request, process.env.REMOTE_ADDR);
	} catch (error) {
		console.error(error);
		response = new Response("Internal Server Error", { status: 500 });
	}
	// A stream failure after headers must not append a second CGI response.
	await writeCGIResponse(response, request.method);
}
