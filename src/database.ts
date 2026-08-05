/**
 * Database abstraction layer that's vaguely ORM-like.
 * Modern (Promises, strict types, tagged template literals), but ORMs
 * are a bit _too_ magical for me, so none of that magic here.
 *
 * @author Zarel
 */

import type * as mysql from "mysql2";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import type * as pg from "pg";

const require = createRequire(import.meta.url);

function loadMySQL(): typeof import("mysql2") {
	return require("mysql2");
}

let pgRuntime: typeof import("pg") | undefined;
function loadPG(): typeof import("pg") {
	if (pgRuntime) return pgRuntime;
	const runtime: typeof import("pg") = require("pg");
	// postgres `bigint` (8-byte integer) values can exceed Number.MAX_SAFE_INTEGER,
	// so pg turns them into strings by default, which are annoying to use and
	// don't match our behavior for mysql and sqlite.
	// in practice, people use 64-bit ints when 32-bit isn't enough, but JS's
	// 52 bits is usually enough, so we default to parsing them as numbers.
	// change this default if you actually need those 12 extra bits.
	runtime.defaults.parseInt8 = true;
	pgRuntime = runtime;
	return runtime;
}

function loadSQLite(): typeof import("node:sqlite") {
	return require("node:sqlite");
}

export type BasicSQLValue = string | number | null;
export type SQLRow = { [k: string]: BasicSQLValue };
export interface SQL {
	readonly __isSQLStatement: true;
	sql: string[];
	values: BasicSQLValue[];
}
export type SQLValue =
	| BasicSQLValue
	| SQL
	| SQL[]
	| PartialOrSQL<SQLRow>
	| BasicSQLValue[]
	| undefined;

export class SQLStatement implements SQL {
	readonly __isSQLStatement = true as const;
	sql: string[];
	values: BasicSQLValue[];
	constructor(strings: TemplateStringsArray | string[], values: SQLValue[]) {
		this.sql = [strings[0] ?? ""];
		this.values = [];
		for (let i = 0; i < strings.length - 1; i++) {
			this.append(values[i]).appendRaw(strings[i + 1] ?? "");
		}
	}
	private lastString(): string {
		return this.sql[this.sql.length - 1]!;
	}
	private overwriteLastString(sql: string) {
		this.sql[this.sql.length - 1] = sql;
	}
	appendRaw(sql: string): this {
		this.overwriteLastString(this.lastString() + sql);
		return this;
	}
	append(value: SQLValue): this {
		if (SQL.isSQL(value)) {
			if (!value.sql.length) return this;
			this.appendRaw(value.sql[0]!);
			this.sql = this.sql.concat(value.sql.slice(1));
			this.values = this.values.concat(value.values);
		} else if (typeof value === "string" || typeof value === "number" || value === null) {
			this.values.push(value);
			this.sql.push("");
		} else if (value === undefined) {
			// Do nothing.
		} else if (Array.isArray(value)) {
			if (!value.length || SQL.isSQL(value[0])) {
				for (const statement of value) this.append(statement);
			} else if ('"`'.includes(this.lastString().slice(-1))) {
				// "`a`, `b`" syntax
				const quoteChar = this.lastString().slice(-1);
				for (const col of value) {
					this.append(col).appendRaw(`${quoteChar}, ${quoteChar}`);
				}
				this.overwriteLastString(this.lastString().slice(0, -4));
			} else {
				// "1, 2" syntax
				for (const val of value) {
					this.append(val).appendRaw(`, `);
				}
				this.overwriteLastString(this.lastString().slice(0, -2));
			}
		} else if (this.lastString().endsWith("(")) {
			// "(`a`, `b`) VALUES (1, 2)" syntax
			this.appendRaw(`"`);
			for (const col in value) {
				this.append(col).appendRaw(`", "`);
			}
			this.overwriteLastString(this.lastString().slice(0, -4) + `") VALUES (`);
			for (const col in value) {
				this.append(value[col]).appendRaw(`, `);
			}
			this.overwriteLastString(this.lastString().slice(0, -2));
		} else if (this.lastString().toUpperCase().endsWith(" SET ")) {
			// "`a` = 1, `b` = 2" syntax
			this.appendRaw(`"`);
			for (const col in value) {
				this.append(col).appendRaw(`" = `);
				this.append(value[col]).appendRaw(`, "`);
			}
			this.overwriteLastString(this.lastString().slice(0, -3));
		} else {
			throw new Error(
				`Objects can only appear in (obj) or after SET; ` +
					`unrecognized: ${this.lastString()}[obj]`,
			);
		}
		return this;
	}
}

/**
 * Tag function for SQL, with some magic.
 *
 * * `` SQL`UPDATE table SET a = ${'hello'}` ``
 *   * `` `UPDATE table SET a = 'hello'` ``
 *
 * Values surrounded by `"` or `` ` `` become identifiers:
 *
 * * ``` SQL`SELECT * FROM "${'table'}"` ```
 *   * `` `SELECT * FROM "table"` ``
 *
 * (Make sure to use `"` for Postgres and `` ` `` for MySQL.)
 *
 * Objects preceded by SET become setters:
 *
 * * `` SQL`UPDATE table SET ${{a: 1, b: 2}}` ``
 *   * `` `UPDATE table SET "a" = 1, "b" = 2` ``
 *
 * Objects surrounded by `()` become keys and values:
 *
 * * `` SQL`INSERT INTO table (${{a: 1, b: 2}})` ``
 *   * `` `INSERT INTO table ("a", "b") VALUES (1, 2)` ``
 *
 * Arrays become lists; surrounding by `"` or `` ` `` turns them into lists of names:
 *
 * * `` SQL`INSERT INTO table ("${['a', 'b']}") VALUES (${[1, 2]})` ``
 *   * `` `INSERT INTO table ("a", "b") VALUES (1, 2)` ``
 */
export function SQL(strings: TemplateStringsArray | string[] | string, ...values: SQLValue[]) {
	if (typeof strings === "string") strings = [strings];
	return new SQLStatement(strings, values);
}
SQL.isSQL = (value: unknown): value is SQL => {
	return (value as SQL | undefined)?.__isSQLStatement === true;
};

export interface ResultRow {
	[k: string]: BasicSQLValue;
}

export const connectedDatabases: Database<any, any>[] = [];

export async function closeDatabases() {
	const databases = connectedDatabases.splice(0);
	await Promise.all(databases.map(database => database.close()));
}

export abstract class Database<Pool = mysql.Pool | pg.Pool, OkPacket = unknown> {
	connection: Pool;
	prefix: string;
	type = "";
	constructor(connection: Pool, prefix = "") {
		this.prefix = prefix;
		this.connection = connection;
		connectedDatabases.push(this);
	}
	abstract _resolveSQL(query: SQL): [query: string, values: BasicSQLValue[]];
	abstract _query(sql: string, values: BasicSQLValue[]): Promise<any>;
	abstract _queryExec(sql: string, values: BasicSQLValue[]): Promise<OkPacket>;
	abstract escapeId(param: string): string;
	query<T = ResultRow>(sql: SQL): Promise<T[]>;
	query<T = ResultRow>(): (strings: TemplateStringsArray, ...rest: SQLValue[]) => Promise<T[]>;
	query<T = ResultRow>(sql?: SQL) {
		if (!sql) return (strings: any, ...rest: any) => this.query<T>(new SQLStatement(strings, rest));

		const [query, values] = this._resolveSQL(sql);
		return this._query(query, values);
	}
	queryOne<T = ResultRow>(sql: SQL): Promise<T | undefined>;
	queryOne<T = ResultRow>(): (strings: TemplateStringsArray, ...rest: SQLValue[]) => Promise<T | undefined>;
	queryOne<T = ResultRow>(sql?: SQL) {
		if (!sql) return (strings: any, ...rest: any) => this.queryOne<T>(new SQLStatement(strings, rest));

		return this.query<T>(sql).then(res => Array.isArray(res) ? res[0] : res);
	}
	queryExec(sql: SQL): Promise<OkPacket>;
	queryExec(): (strings: TemplateStringsArray, ...rest: SQLValue[]) => Promise<OkPacket>;
	queryExec(sql?: SQL) {
		if (!sql) return (strings: any, ...rest: any) => this.queryExec(new SQLStatement(strings, rest));

		const [query, values] = this._resolveSQL(sql);
		return this._queryExec(query, values);
	}
	getTable<Row>(name: string, primaryKeyName: keyof Row & string | null = null): DatabaseTable<Row, this> {
		return new DatabaseTable<Row, this>(this, name, primaryKeyName);
	}
	abstract close(): Promise<void>;
}

type PartialOrSQL<T> = {
	[P in keyof T]?: T[P] | SQL;
};

type OkPacketOf<DB extends Database> = DB extends Database<any, infer T> ? T : never;

// Row extends SQLRow but TS doesn't support closed types so we can't express this
export class DatabaseTable<Row, DB extends Database<any, any>> {
	db: DB;
	name: string;
	primaryKeyName: keyof Row & string | null;
	constructor(
		db: DB,
		name: string,
		primaryKeyName: keyof Row & string | null = null,
	) {
		this.db = db;
		this.name = db.prefix + name;
		this.primaryKeyName = primaryKeyName;
	}
	escapeId(param: string) {
		return this.db.escapeId(param);
	}

	// raw

	query<T = Row>(sql: SQL): Promise<T[]>;
	query<T = Row>(): (strings: TemplateStringsArray, ...rest: SQLValue[]) => Promise<T[]>;
	query<T = Row>(sql?: SQL) {
		return this.db.query<T>(sql as any) as any;
	}
	queryOne<T = Row>(sql: SQL): Promise<T | undefined>;
	queryOne<T = Row>(): (strings: TemplateStringsArray, ...rest: SQLValue[]) => Promise<T | undefined>;
	queryOne<T = Row>(sql?: SQL) {
		return this.db.queryOne<T>(sql as any) as any;
	}
	queryExec(sql: SQL): Promise<OkPacketOf<DB>>;
	queryExec(): (strings: TemplateStringsArray, ...rest: SQLValue[]) => Promise<OkPacketOf<DB>>;
	queryExec(sql?: SQL) {
		return this.db.queryExec(sql as any) as any;
	}

	// low-level

	selectAll<T = Row>(
		entries?: (keyof Row & string)[] | SQL,
	): (strings: TemplateStringsArray, ...rest: SQLValue[]) => Promise<T[]> {
		if (!entries) entries = SQL`*`;
		if (Array.isArray(entries)) entries = SQL`"${entries}"`;
		return (strings, ...rest) =>
			this.query<T>()`SELECT ${entries} FROM "${this.name}" ${new SQLStatement(strings, rest)}`;
	}
	selectOne<T = Row>(
		entries?: (keyof Row & string)[] | SQL,
	): (strings: TemplateStringsArray, ...rest: SQLValue[]) => Promise<T | undefined> {
		if (!entries) entries = SQL`*`;
		if (Array.isArray(entries)) entries = SQL`"${entries}"`;
		return (strings, ...rest) =>
			this.queryOne<T>()`SELECT ${entries} FROM "${this.name}" ${new SQLStatement(strings, rest)} LIMIT 1`;
	}
	updateAll(
		partialRow: PartialOrSQL<Row>,
	): (strings: TemplateStringsArray, ...rest: SQLValue[]) => Promise<OkPacketOf<DB>> {
		return (strings, ...rest) =>
			this.queryExec()`UPDATE "${this.name}" SET ${partialRow as any} ${new SQLStatement(strings, rest)}`;
	}
	updateOne(
		partialRow: PartialOrSQL<Row> | SQL,
	): (strings: TemplateStringsArray, ...rest: SQLValue[]) => Promise<OkPacketOf<DB>> {
		if (this.db.type === "sqlite") {
			// sqlite usually doesn't support UPDATE ... LIMIT 1
			return (strings, ...rest) =>
				this.queryExec()`UPDATE "${this.name}" SET ${partialRow as any}
				WHERE rowid = (
					SELECT rowid FROM "${this.name}" ${new SQLStatement(strings, rest)} LIMIT 1
				)`;
		}
		if (this.db.type === "pg") {
			return (strings, ...rest) =>
				this.queryExec()`UPDATE "${this.name}" SET ${partialRow as any} ${new SQLStatement(strings, rest)}`;
		}
		return (s, ...r) =>
			this.queryExec()`UPDATE "${this.name}" SET ${partialRow as any} ${new SQLStatement(s, r)} LIMIT 1`;
	}
	deleteAll(): (strings: TemplateStringsArray, ...rest: SQLValue[]) => Promise<OkPacketOf<DB>> {
		return (strings, ...rest) => this.queryExec()`DELETE FROM "${this.name}" ${new SQLStatement(strings, rest)}`;
	}
	deleteOne(): (strings: TemplateStringsArray, ...rest: SQLValue[]) => Promise<OkPacketOf<DB>> {
		if (this.db.type === "sqlite") {
			// sqlite usually doesn't support DELETE ... LIMIT 1
			return (strings, ...rest) =>
				this.queryExec()`DELETE FROM "${this.name}"
				WHERE rowid = (
					SELECT rowid FROM "${this.name}" ${new SQLStatement(strings, rest)} LIMIT 1
				)`;
		}
		if (this.db.type === "pg") {
			return (strings, ...rest) => this.queryExec()`DELETE FROM "${this.name}" ${new SQLStatement(strings, rest)}`;
		}
		return (strings, ...rest) =>
			this.queryExec()`DELETE FROM "${this.name}" ${new SQLStatement(strings, rest)} LIMIT 1`;
	}
	eval<T>(): (strings: TemplateStringsArray, ...rest: SQLValue[]) => Promise<T | undefined> {
		return (strings, ...rest) =>
			this.queryOne<{ result: T }>()`SELECT ${new SQLStatement(strings, rest)} AS result FROM "${this.name}" LIMIT 1`
				.then(row => row?.result);
	}

	// high-level

	insert(partialRow: PartialOrSQL<Row>, where?: SQL) {
		return this.queryExec()`INSERT INTO "${this.name}" (${partialRow as SQLValue}) ${where}`;
	}
	insertIgnore(partialRow: PartialOrSQL<Row>, where?: SQL) {
		if (this.db.type === "sqlite") {
			// sqlite usually doesn't support DELETE ... LIMIT 1
			return this.queryExec()`INSERT OR IGNORE INTO "${this.name}" (${partialRow as SQLValue}) ${where}`;
		}
		return this.queryExec()`INSERT IGNORE INTO "${this.name}" (${partialRow as SQLValue}) ${where}`;
	}
	async tryInsert(partialRow: PartialOrSQL<Row>, where?: SQL) {
		try {
			return await this.insert(partialRow, where);
		} catch (err: any) {
			if (err.code === "ER_DUP_ENTRY") {
				return undefined;
			}
			if (
				this.db.type === "sqlite" &&
				[1555, 2067].includes(err.errcode)
			) return undefined;
			throw err;
		}
	}
	upsert(partialRow: PartialOrSQL<Row>, partialUpdate = partialRow, where?: SQL) {
		if (this.db.type === "sqlite" || this.db.type === "pg") {
			if (!this.primaryKeyName) throw new Error(`Cannot upsert() without a single-column primary key`);
			return this
				.queryExec()`INSERT INTO "${this.name}" (${partialRow as any}) ON CONFLICT ("${this.primaryKeyName}") DO UPDATE SET ${partialUpdate as any} ${where}`;
		}
		return this
			.queryExec()`INSERT INTO "${this.name}" (${partialRow as any}) ON DUPLICATE KEY UPDATE ${partialUpdate as any} ${where}`;
	}
	set(primaryKey: BasicSQLValue, partialRow: PartialOrSQL<Row>, where?: SQL) {
		if (!this.primaryKeyName) throw new Error(`Cannot set() without a single-column primary key`);
		partialRow[this.primaryKeyName] = primaryKey as any;
		return this.replace(partialRow, where);
	}
	replace(partialRow: PartialOrSQL<Row>, where?: SQL) {
		if (this.db.type === "pg") {
			if (!this.primaryKeyName) throw new Error(`Cannot replace() without a single-column primary key`);
			return this
				.queryExec()`INSERT INTO "${this.name}" (${partialRow as any}) ON CONFLICT ("${this.primaryKeyName}") DO UPDATE SET ${partialRow as any} ${where}`;
		}
		return this.queryExec()`REPLACE INTO "${this.name}" (${partialRow as SQLValue}) ${where}`;
	}
	get(primaryKey: BasicSQLValue, entries?: (keyof Row & string)[] | SQL) {
		if (!this.primaryKeyName) throw new Error(`Cannot get() without a single-column primary key`);
		return this.selectOne(entries)`WHERE "${this.primaryKeyName}" = ${primaryKey}`;
	}
	delete(primaryKey: BasicSQLValue) {
		if (!this.primaryKeyName) throw new Error(`Cannot delete() without a single-column primary key`);
		return this.deleteAll()`WHERE "${this.primaryKeyName}" = ${primaryKey}`;
	}
	update(primaryKey: BasicSQLValue, data: PartialOrSQL<Row>) {
		if (!this.primaryKeyName) throw new Error(`Cannot update() without a single-column primary key`);
		return this.updateAll(data)`WHERE "${this.primaryKeyName}" = ${primaryKey}`;
	}
}

export class MySQLDatabase extends Database<mysql.Pool, mysql.OkPacket> {
	override type = "mysql" as const;
	constructor(config: mysql.PoolOptions & { prefix?: string }) {
		const prefix = config.prefix || "";
		if (config.prefix) {
			config = { ...config };
			delete config.prefix;
		}
		super(loadMySQL().createPool(config), prefix);
	}
	override _resolveSQL(query: SQL): [query: string, values: BasicSQLValue[]] {
		let sql = query.sql[0]!;
		const values: BasicSQLValue[] = [];
		for (let i = 0; i < query.values.length; i++) {
			const value = query.values[i]!;
			const nextSQL = query.sql[i + 1]!;
			if (nextSQL.startsWith("`") || nextSQL.startsWith('"')) {
				sql = sql.slice(0, -1) + this.escapeId(`${value as any}`) + nextSQL.slice(1);
			} else {
				sql += "?" + nextSQL;
				values.push(value);
			}
		}
		return [sql, values];
	}
	override _query(query: string, values: BasicSQLValue[]): Promise<any> {
		return new Promise((resolve, reject) => {
			this.connection.execute(query, values, (e, results: any) => {
				if (e) {
					return reject(new Error(`${e.message} (${query}) (${values as any}) [${e.code}]`));
				}
				if (Array.isArray(results)) {
					for (const row of results) {
						for (const col in row) {
							if (Buffer.isBuffer(row[col])) row[col] = row[col].toString();
						}
					}
				}
				return resolve(results);
			});
		});
	}
	override _queryExec(sql: string, values: BasicSQLValue[]): Promise<mysql.OkPacket> {
		return this._query(sql, values);
	}
	override escapeId(id: string) {
		return loadMySQL().escapeId(id);
	}
	override close() {
		return new Promise<void>((resolve, reject) => {
			this.connection.end(err => err ? reject(err) : resolve());
		});
	}
}

export class PGDatabase extends Database<pg.Pool, { affectedRows: number | null }> {
	override type = "pg" as const;
	constructor(config: pg.PoolConfig) {
		super(new (loadPG().Pool)(config));
	}
	override _resolveSQL(query: SQL): [query: string, values: BasicSQLValue[]] {
		let sql = query.sql[0]!;
		const values: BasicSQLValue[] = [];
		let paramCount = 0;
		for (let i = 0; i < query.values.length; i++) {
			const value = query.values[i]!;
			const nextSQL = query.sql[i + 1]!;
			if (nextSQL.startsWith("`") || nextSQL.startsWith('"')) {
				sql = sql.slice(0, -1) + this.escapeId(`${value as any}`) + nextSQL.slice(1);
			} else {
				paramCount++;
				sql += `$${paramCount}` + nextSQL;
				values.push(value);
			}
		}
		return [sql, values];
	}
	override _query(query: string, values: BasicSQLValue[]) {
		return this.connection.query(query, values).then(res => res.rows);
	}
	override _queryExec(query: string, values: BasicSQLValue[]) {
		return this.connection.query<never>(query, values).then(res => ({ affectedRows: res.rowCount }));
	}
	override escapeId(id: string) {
		return loadPG().escapeIdentifier(id);
	}
	override close() {
		return this.connection.end();
	}
}

export interface SQLiteDatabaseConfig {
	path?: string;
	prefix?: string;
}

export interface SQLiteResult {
	affectedRows: number;
	insertId: number;
}

export class SQLiteDatabase extends Database<import("node:sqlite").DatabaseSync, SQLiteResult> {
	override type = "sqlite";

	constructor(config: SQLiteDatabaseConfig = {}) {
		super(new (loadSQLite().DatabaseSync)(config.path || ":memory:"), config.prefix || "");
	}

	override _resolveSQL(query: SQL): [query: string, values: BasicSQLValue[]] {
		let sql = query.sql[0]!;
		const values: BasicSQLValue[] = [];
		for (let i = 0; i < query.values.length; i++) {
			const value = query.values[i]!;
			const nextSQL = query.sql[i + 1]!;
			if (nextSQL.startsWith("`") || nextSQL.startsWith('"')) {
				sql = sql.slice(0, -1) + this.escapeId(`${value as any}`) + nextSQL.slice(1);
			} else {
				sql += "?" + nextSQL;
				values.push(value);
			}
		}
		return [sql, values];
	}

	override _query(query: string, values: BasicSQLValue[]) {
		return Promise.resolve().then(() => {
			const rows = this.connection.prepare(query).all(...values);
			return rows.map(row => ({ ...(row as Record<string, unknown>) }));
		});
	}

	override _queryExec(query: string, values: BasicSQLValue[]) {
		return Promise.resolve().then(() => {
			const result = this.connection.prepare(query).run(...values);
			return {
				affectedRows: Number(result.changes),
				insertId: Number(result.lastInsertRowid),
			};
		});
	}

	override escapeId(id: string) {
		return `"${id.replace(/"/g, '""')}"`;
	}

	override close() {
		return Promise.resolve().then(() => this.connection.close());
	}
}

export class MockDatabase extends SQLiteDatabase {
	readonly name: string;

	constructor(config: SQLiteDatabaseConfig | null | undefined, name: string) {
		super({ path: ":memory:", prefix: config?.prefix ?? "" });
		this.name = name;
		if (config?.path) this.connection.exec(fs.readFileSync(config.path, "utf8"));
	}
}
