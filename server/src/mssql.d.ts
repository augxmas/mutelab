declare module 'mssql' {
  export class ConnectionPool {
    constructor(config: Record<string, unknown>);
    on(event: string, listener: (error: Error) => void): this;
    connect(): Promise<ConnectionPool>;
    request(): { input(name: string, value: unknown): this; query(query: string): Promise<{ recordset: unknown[] }> };
  }
  const sql: { ConnectionPool: typeof ConnectionPool };
  export default sql;
}
