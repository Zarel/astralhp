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
import { canonicalPath, findProjectDir, type ManagedProject, managedProject } from "./config-loader.js";
import { Webroot } from "./webroot.js";

const RUNTIME_DIRECTORY = path.join(".caches", "run");
const CONTROL_SOCKET = path.join(RUNTIME_DIRECTORY, "control.sock");

function createRuntimeDir(projectDir: string): string {
	const runtime = path.join(projectDir, RUNTIME_DIRECTORY);
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
	readonly lookupDirectories: string[];

	private constructor(reply: string) {
		const info = JSON.parse(reply);
		this.id = info.id;
		this.pid = info.pid;
		this.worker = info.worker;
		this.socket = info.socket;
		this.webroots = info.webroots;
		this.lookupDirectories = info.lookupDirectories ?? info.webroots;
	}

	static async startBackground(project: ManagedProject): Promise<string> {
		const runtime = createRuntimeDir(project.projectDir);
		const log = fs.openSync(path.join(runtime, "server.log"), "a", 0o600);
		try {
			const child = fork(import.meta.filename, [], {
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
				child.send(project);
			});
		} finally {
			fs.closeSync(log);
		}
	}

	private static async requestInProject(command: Command, directory: string): Promise<string | null> {
		const target = fs.realpathSync(directory);
		const projectDir = findProjectDir(target);
		process.chdir(projectDir);
		const reply = await RemoteManager.request(command);
		if (reply !== null) return reply;

		// Older managers may still have their socket in the selected webroot.
		if (target !== projectDir && fs.existsSync(path.join(target, CONTROL_SOCKET))) {
			process.chdir(target);
			const legacy = await RemoteManager.request(command);
			if (legacy !== null) return legacy;
		}

		// A configured webroot can live outside the project or have its own package.json.
		const managers = await RemoteManager.list();
		const owners = managers.filter(manager => manager.lookupDirectories.includes(target));
		if (owners.length > 1) throw new Error(`Multiple projects use ${target}. Specify the project directory.`);
		const [owner] = owners;
		if (owner) return RemoteManager.request(command, owner.id);
		return null;
	}

	static async control(command: "reload" | "stop", directory = "."): Promise<string> {
		const reply = await RemoteManager.requestInProject(command, directory);
		if (reply !== null) return reply;
		if (command === "stop") return "AstralHP is already stopped.";
		throw new Error("AstralHP is not running. Run astralhp start first.");
	}

	// A null reply means this connection acquired the project's write transaction.
	static async claimOrContact(lock: DatabaseSync, webroots: string[]): Promise<string | null> {
		const deadline = performance.now() + 2000;
		while (true) {
			try {
				lock.exec("BEGIN IMMEDIATE");
				return null;
			} catch (error) {
				// SQLITE_BUSY is errcode 5.
				if ((error as any)?.errcode !== 5) throw error;
			}
			const reply = await RemoteManager.request("start", CONTROL_SOCKET, webroots);
			if (reply !== null) return reply;
			// The owner may still be binding its socket, or finishing shutdown.
			if (performance.now() >= deadline) throw new Error("Manager lock is busy but the control socket is unavailable.");
			await delay(25);
		}
	}

	static async status(directory: string): Promise<RemoteManager | null> {
		const reply = await RemoteManager.requestInProject("status", directory);
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

	private static request(command: Command, socketPath = CONTROL_SOCKET, webroots?: string[]): Promise<string | null> {
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
			req.end(webroots && JSON.stringify(webroots));
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
	private readonly project: ManagedProject;
	private readonly index = path.resolve(managerIndexDir());
	private readonly id = randomUUID();
	private readonly server: http.Server;
	private worker: AstralHPLiveProcess | undefined;
	private stopping = false;
	private pending: Promise<unknown> = Promise.resolve();

	constructor(project: ManagedProject) {
		this.project = project;
		this.webroots = project.configs.map(Webroot.fromLoadedConfig);
		this.server = http.createServer((req, res) => {
			if (req.method === "POST" && req.url === "/status") {
				const info: RemoteManager = {
					id: this.id,
					pid: process.pid,
					worker: this.worker ? "running" : "stopped",
					socket: path.resolve(CONTROL_SOCKET),
					webroots: this.webroots.map(webroot => webroot.path),
					lookupDirectories: project.lookupDirectories,
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

	async listen(): Promise<string> {
		// Keep the socket relative to this directory for both bind and unlink.
		process.chdir(this.project.projectDir);
		const runtime = createRuntimeDir(this.project.projectDir);
		const { DatabaseSync } = await import("node:sqlite");
		const lock = new DatabaseSync(path.join(runtime, "manager.sqlite"));
		try {
			const reply = await RemoteManager.claimOrContact(lock, this.webroots.map(site => canonicalPath(site.path)));
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
		const worker = await start(this.webroots, options);
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
			case "/start": {
				const requested: string[] = JSON.parse(await text(req));
				const serving = this.webroots.map(site => canonicalPath(site.path));
				if (requested.length !== serving.length || !requested.every(root => serving.includes(root))) {
					throw new Error([
						`This project's manager is configured for: ${serving.join(", ")}.`,
						`Requested: ${requested.join(", ")}. The requested selection was not started.`,
						"Run astralhp stop before changing webroots.",
					].join("\n"));
				}
				if (!this.worker) throw new Error("The worker is stopped. Run astralhp reload to retry.");
				res.end(["AstralHP is already running.", ...this.worker.urls].join("\n"));
				break;
			}
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

export async function serve(webroot?: string, background = false): Promise<string> {
	const project = await managedProject(webroot);
	return background ? RemoteManager.startBackground(project) : new ServerManager(project).listen();
}

if (import.meta.main) {
	process.once("message", async (project: ManagedProject) => {
		try {
			const message = await new ServerManager(project).listen();
			console.log(message);
			process.send!({ message });
		} catch (error) {
			const message = (error as Error).message;
			console.error(message);
			process.send!({ message, failed: true });
			process.exitCode = 1;
		}
	});
}
