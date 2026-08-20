export interface Connection {
  id: string;
  name: string;
  type: string;
  host?: string;
  port?: number;
  is_active: boolean;
  sourceTable: "connection" | "dremio_source";
}
