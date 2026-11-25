declare module 'mssql' {
  export interface Request {
    input(name: string, value: unknown): this;
    query<T = Record<string, unknown>>(query: string): Promise<{ recordset: T[] }>;
    execute<T = Record<string, unknown>>(procedure: string): Promise<{ recordset: T[] }>;
  }
  export class ConnectionPool {
    constructor(config: Record<string, unknown>);
    on(event: string, listener: (error: Error) => void): this;
    connect(): Promise<ConnectionPool>;
    request(): Request;
    close(): Promise<void>;
  }
  const sql: { ConnectionPool: typeof ConnectionPool };
  export default sql;
}
