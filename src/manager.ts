import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { text } from "node:stream/consumers";
import { setTimeout as delay } from "node:timers/promises";
import { type AstralHPLiveProcess, start } from "./astro.js";
import { Webroot } from "./webroot.js";

const RUNTIME_DIRECTORY = path.join(".caches", "run");
const CONTROL_SOCKET = path.join(RUNTIME_DIRECTORY, "control.sock");

function createRuntimeDir(webroot?: string): string {
	const runtime = path.join(fs.realpathSync(webroot ?? "."), RUNTIME_DIRECTORY);
	fs.mkdirSync(path.dirname(runtime), { recursive: true });
	fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
	return runtime;
}

function managerIndexDir(): string {
	return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "astralhp", "managers");
}

type Command = "start" | "reload" | "stop" | "status";

export class RemoteManager {
	readonly id: string;
	readonly pid: number;
	readonly worker: string;
	readonly socket: string;
	readonly webroots: string[];

	private constructor(reply: string) {
		const info = JSON.parse(reply);
		this.id = info.id;
		this.pid = info.pid;
		this.worker = info.worker;
		this.socket = info.socket;
		this.webroots = info.webroots;
	}

	static async startBackground(webroot?: string): Promise<string> {
		const runtime = createRuntimeDir(webroot);
		const log = fs.openSync(path.join(runtime, "server.log"), "a", 0o600);
		try {
			const args = webroot === undefined ? ["serve"] : ["serve", webroot];
			const child = fork(new URL("./cli.js", import.meta.url), args, {
				detached: true,
				stdio: ["ignore", log, log, "ipc"],
			});
			return await new Promise<string>((resolve, reject) => {
				child.once("error", reject);
				child.once("exit", code => reject(new Error(`AstralHP exited during startup (${code}).`)));
				child.once("message", (reply: { message: string; failed?: boolean }) => {
					child.disconnect();
					child.unref();
					if (reply.failed) reject(new Error(reply.message));
					else resolve(reply.message);
				});
			});
		} finally {
			fs.closeSync(log);
		}
	}

	static async control(command: "reload" | "stop", projectDir?: string): Promise<string> {
		if (projectDir !== undefined) process.chdir(projectDir);
		const reply = await RemoteManager.request(command);
		if (reply !== null) return reply;
		if (command === "stop") return "AstralHP is already stopped.";
		throw new Error("AstralHP is not running. Run astralhp start first.");
	}

	// A null reply means this connection acquired the project's write transaction.
	static async claimOrContact(lock: DatabaseSync): Promise<string | null> {
		const deadline = performance.now() + 2000;
		while (true) {
			try {
				lock.exec("BEGIN IMMEDIATE");
				return null;
			} catch (error) {
				// SQLITE_BUSY is errcode 5.
				if ((error as any)?.errcode !== 5) throw error;
			}
			const reply = await RemoteManager.request("start");
			if (reply !== null) return reply;
			// The owner may still be binding its socket, or finishing shutdown.
			if (performance.now() >= deadline) throw new Error("Manager lock is busy but the control socket is unavailable.");
			await delay(25);
		}
	}

	static async status(projectDir: string): Promise<RemoteManager | null> {
		process.chdir(projectDir);
		const reply = await RemoteManager.request("status");
		return reply === null ? null : new RemoteManager(reply);
	}

	static async list(): Promise<RemoteManager[]> {
		try {
			// Bypass the Unix socket pathname limit with the shortest possible relative path.
			process.chdir(managerIndexDir());
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		const entries = fs.readdirSync(".", { withFileTypes: true }).filter(entry => entry.isSymbolicLink());
		const results = await Promise.allSettled(entries.map(entry => RemoteManager.readIndexEntry(entry.name)));
		const managers: RemoteManager[] = [];
		for (const result of results) {
			if (result.status === "rejected") console.warn(`Could not inspect an AstralHP manager: ${result.reason.message}`);
			else if (result.value) managers.push(result.value);
		}
		return managers.sort((a, b) => a.pid - b.pid);
	}

	private static request(command: Command, socketPath = CONTROL_SOCKET): Promise<string | null> {
		return new Promise((resolve, reject) => {
			const req = http.request({ socketPath, method: "POST", path: `/${command}` }, response => {
				text(response).then(message => {
					if (response.statusCode === 200) resolve(message);
					else reject(new Error(message));
				}, reject);
			});
			if (command === "status") req.setTimeout(2000, () => req.destroy(new Error("Manager did not respond.")));
			req.on("error", (error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT" || error.code === "ECONNREFUSED") resolve(null);
				else reject(error);
			});
			req.end();
		});
	}

	private static async readIndexEntry(entry: string): Promise<RemoteManager | null> {
		const reply = await RemoteManager.request("status", entry);
		if (reply !== null) {
			const manager = new RemoteManager(reply);
			if (manager.id === entry) return manager;
		}
		// This registration is unique to one manager, even if a replacement is
		// already listening at the same project socket path.
		fs.rmSync(entry, { force: true });
		return null;
	}
}

class ServerManager {
	private readonly webroots: Webroot[];
	private readonly workerCwd = process.cwd();
	private readonly index = path.resolve(managerIndexDir());
	private readonly id = randomUUID();
	private readonly server: http.Server;
	private worker: AstralHPLiveProcess | undefined;
	private stopping = false;
	private pending: Promise<unknown> = Promise.resolve();

	constructor(webroots: Webroot[]) {
		this.webroots = webroots;
		this.server = http.createServer((req, res) => {
			if (req.method === "POST" && req.url === "/status") {
				const info: RemoteManager = {
					id: this.id,
					pid: process.pid,
					worker: this.worker ? "running" : "stopped",
					socket: path.resolve(CONTROL_SOCKET),
					webroots: this.webroots.map(webroot => webroot.path),
				};
				res.end(JSON.stringify(info));
				return;
			}
			// Queue commands behind startup and each other. Report each failure
			// to its caller so the next command can still run.
			this.pending = this.pending.then(() => this.handleRequest(req, res)).catch(error => {
				res.writeHead(500).end(error.message);
			});
		});
	}

	async listen(projectDir?: string): Promise<string> {
		// Keep the socket relative to this directory for both bind and unlink.
		if (projectDir !== undefined) process.chdir(projectDir);
		const runtime = createRuntimeDir();
		const { DatabaseSync } = await import("node:sqlite");
		const lock = new DatabaseSync(path.join(runtime, "manager.sqlite"));
		try {
			const reply = await RemoteManager.claimOrContact(lock);
			if (reply !== null) {
				if (!process.send) throw new Error(reply);
				lock.close();
				return reply;
			}
			// Only the lock owner can have a listener here. A socket left by
			// the previous owner is safe to unlink.
			if (fs.lstatSync(CONTROL_SOCKET, { throwIfNoEntry: false })?.isSocket()) fs.unlinkSync(CONTROL_SOCKET);
			this.server.listen(CONTROL_SOCKET);
			await once(this.server, "listening");
		} catch (error) {
			lock.close();
			throw error;
		}
		this.server.once("close", () => lock.close());

		const startup = this.launchWorker({ logStartup: false });
		this.pending = startup;
		try {
			const worker = await startup;
			this.register();
			return worker.startupMessage;
		} catch (error) {
			this.stopping = true;
			this.server.close();
			throw error;
		}
	}

	private register(): void {
		const link = path.join(this.index, this.id);
		try {
			fs.mkdirSync(this.index, { recursive: true, mode: 0o700 });
			fs.symlinkSync(path.resolve(CONTROL_SOCKET), link);
		} catch (error) {
			console.warn(`Could not register with astralhp ps: ${(error as Error).message}`);
			return;
		}
		this.server.once("close", () => fs.rmSync(link, { force: true }));
	}

	private async launchWorker(options: { logStartup?: boolean } = {}): Promise<AstralHPLiveProcess> {
		const worker = await start(this.webroots, options, this.workerCwd);
		this.worker = worker;
		worker.finished.catch(error => console.error(error.message)).finally(() => {
			if (this.worker === worker) this.worker = undefined;
		});
		return worker;
	}

	private async reload(): Promise<void> {
		await this.worker?.close();
		await this.launchWorker();
	}

	private async stop(): Promise<void> {
		await this.worker?.close();
		this.stopping = true;
		this.server.close(() => process.exit(0));
	}

	private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		if (req.method !== "POST" || !["/start", "/reload", "/stop"].includes(req.url ?? "")) {
			res.writeHead(404).end();
			return;
		}
		if (this.stopping) throw new Error("AstralHP is stopping.");
		switch (req.url) {
			case "/start":
				if (!this.worker) throw new Error("The worker is stopped. Run astralhp reload to retry.");
				res.end(["AstralHP is already running.", ...this.worker.urls].join("\n"));
				break;
			case "/reload":
				await this.reload();
				res.end("AstralHP reloaded.");
				break;
			case "/stop":
				await this.stop();
				res.end("AstralHP stopped.");
				break;
		}
	}
}

export async function serve(webroot?: string): Promise<string> {
	const webroots = webroot === undefined ? await Webroot.requireAll() : [await Webroot.resolve(webroot)];
	return new ServerManager(webroots).listen(webroot);
}
