import type { Storage } from '@earendil-works/pi-durable';
import {
  type SqliteDatabase,
  type SqliteExecutor,
  SqliteStorage,
  type SqliteValue,
} from '@earendil-works/pi-durable/storage/sqlite';
import init, { type Database, type PreparedStatement } from '@sqlite.org/sqlite-wasm';

type Row = Record<string, unknown>;

class SerialQueue {
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.#tail.then(operation);
    this.#tail = result.catch(() => {});
    return result;
  }
}

class Statements {
  readonly #db: Database;
  readonly #cache = new Map<string, PreparedStatement>();

  constructor(db: Database) {
    this.#db = db;
  }

  bound(sql: string, params: readonly SqliteValue[]): PreparedStatement {
    let statement = this.#cache.get(sql);
    if (!statement) {
      statement = this.#db.prepare(sql);
      this.#cache.set(sql, statement);
    }
    statement.reset(true);
    if (params.length > 0) statement.bind([...params]);
    return statement;
  }

  finalize(): void {
    for (const statement of this.#cache.values()) statement.finalize();
    this.#cache.clear();
  }
}

class WasmSqliteExecutor implements SqliteExecutor {
  protected readonly db: Database;
  protected readonly statements: Statements;

  constructor(db: Database, statements: Statements) {
    this.db = db;
    this.statements = statements;
  }

  async exec(sql: string): Promise<void> {
    this.check();
    this.db.exec(sql);
  }

  async run(sql: string, ...params: SqliteValue[]): Promise<void> {
    this.check();
    this.statements.bound(sql, params).stepReset();
  }

  async get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
    this.check();
    const statement = this.statements.bound(sql, params);
    const row = statement.step() ? (statement.get({}) as Row as T) : undefined;
    statement.reset();
    return row;
  }

  async all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
    this.check();
    const statement = this.statements.bound(sql, params);
    const rows: T[] = [];
    while (statement.step()) rows.push(statement.get({}) as Row as T);
    statement.reset();
    return rows;
  }

  protected check(): void {}
}

class WasmSqliteTransaction extends WasmSqliteExecutor {
  active = true;

  protected override check(): void {
    if (!this.active) throw new Error('SQLite transaction handle is no longer active');
  }
}

export class WasmSqliteDatabase extends WasmSqliteExecutor implements SqliteDatabase {
  readonly #queue = new SerialQueue();

  constructor(db: Database) {
    super(db, new Statements(db));
  }

  override exec(sql: string): Promise<void> {
    return this.#queue.run(() => super.exec(sql));
  }

  override run(sql: string, ...params: SqliteValue[]): Promise<void> {
    return this.#queue.run(() => super.run(sql, ...params));
  }

  override get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
    return this.#queue.run(() => super.get<T>(sql, ...params));
  }

  override all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
    return this.#queue.run(() => super.all<T>(sql, ...params));
  }

  transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
    return this.#queue.run(async () => {
      const transaction = new WasmSqliteTransaction(this.db, this.statements);
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const result = await callback(transaction);
        this.db.exec('COMMIT');
        return result;
      } catch (error) {
        this.#rollback(error);
        throw error;
      } finally {
        transaction.active = false;
      }
    });
  }

  close(): Promise<void> {
    return this.#queue.run(() => {
      this.statements.finalize();
      this.db.close();
    });
  }

  #rollback(cause: unknown): void {
    try {
      this.db.exec('ROLLBACK');
    } catch (error) {
      throw new AggregateError([cause, error], 'SQLite rollback failed');
    }
  }
}

export interface OpfsSqliteOptions {
  directory?: string;
  file?: string;
  load?: typeof init;
}

export const AGENT_DIRECTORY = '/.slicc/agent';

export async function openMemorySqliteStorage(): Promise<Storage> {
  const sqlite3 = await init();
  return SqliteStorage.open(new WasmSqliteDatabase(new sqlite3.oo1.DB(':memory:', 'ct')));
}

export async function openOpfsSqliteStorage(options: OpfsSqliteOptions = {}): Promise<Storage> {
  const sqlite3 = await (options.load ?? init)();
  const pool = await sqlite3.installOpfsSAHPoolVfs({
    name: 'slicc-agent',
    directory: options.directory ?? AGENT_DIRECTORY,
  });
  const db = new pool.OpfsSAHPoolDb(options.file ?? '/agent.sqlite');
  db.exec('PRAGMA journal_mode = TRUNCATE');
  return SqliteStorage.open(new WasmSqliteDatabase(db));
}
