declare module 'mssql' {
  export interface Request {
    input(name: string, value: unknown): this;
    query<T = Record<string, unknown>>(query: string): Promise<{ recordset: T[] }>;
    execute<T = Record<string, unknown>>(procedure: string): Promise<{ recordset: T[]; recordsets: T[][] }>;
  }
  export class Request {
    constructor(parent?: ConnectionPool | Transaction);
  }
  export class Transaction {
    constructor(pool: ConnectionPool);
    begin(isolationLevel?: number): Promise<void>;
    commit(): Promise<void>;
    rollback(): Promise<void>;
  }
  export class ConnectionPool {
    constructor(config: Record<string, unknown>);
    on(event: string, listener: (error: Error) => void): this;
    connect(): Promise<ConnectionPool>;
    request(): Request;
    close(): Promise<void>;
  }
  export const ISOLATION_LEVEL: { SERIALIZABLE: number };
  const sql: {
    ConnectionPool: typeof ConnectionPool;
    Request: typeof Request;
    Transaction: typeof Transaction;
    ISOLATION_LEVEL: typeof ISOLATION_LEVEL;
  };
  export default sql;
}
