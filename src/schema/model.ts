// Modelo de esquema independiente del AST de Postgres.
// Todo lo que dibuja el diagrama sale de aquí.

export type FkAction = 'NO ACTION' | 'RESTRICT' | 'CASCADE' | 'SET NULL' | 'SET DEFAULT';

export interface Column {
  name: string;
  /** Tipo tal como se escribiría en SQL: `varchar(255)[]`, `app.mood`, ... */
  type: string;
  /** Nombre del tipo base sin modificadores ni arrays, calificado si venía calificado. */
  typeRef: string;
  isArray: boolean;
  nullable: boolean;
  primaryKey: boolean;
  unique: boolean;
  defaultExpr?: string;
  identity?: 'ALWAYS' | 'BY DEFAULT';
  generated?: string;
  collation?: string;
  checks: string[];
  comment?: string;
  /** Columna heredada (INHERITS / PARTITION OF / LIKE). */
  inherited?: boolean;
  /** Clave del tipo definido por el usuario (enum, compuesto, dominio...) si aplica. */
  typeKey?: string;
}

export interface ForeignKey {
  name?: string;
  columns: string[];
  /** Clave (schema.nombre) de la tabla referenciada, resuelta tras el parseo. */
  refTable: string;
  refColumns: string[];
  onDelete: FkAction;
  onUpdate: FkAction;
  match?: 'FULL' | 'PARTIAL' | 'SIMPLE';
  deferrable?: boolean;
  /** La tabla destino no está definida en el SQL. */
  unresolved?: boolean;
}

export interface Index {
  name?: string;
  columns: string[];
  unique: boolean;
  method?: string;
  where?: string;
  include?: string[];
  primary?: boolean;
}

export interface TableConstraint {
  name?: string;
  kind: 'PRIMARY KEY' | 'UNIQUE' | 'CHECK' | 'EXCLUDE';
  columns: string[];
  expr?: string;
}

export interface Table {
  kind: 'table';
  key: string;
  schema: string;
  name: string;
  columns: Column[];
  primaryKey: string[];
  foreignKeys: ForeignKey[];
  constraints: TableConstraint[];
  indexes: Index[];
  triggers: string[];
  policies: string[];
  comment?: string;
  persistence: 'permanent' | 'unlogged' | 'temporary';
  inherits: string[];
  partitionOf?: string;
  partitionBound?: string;
  partitionBy?: string;
  ofType?: string;
  rls?: boolean;
  /** Línea donde se define (1-based). */
  line: number;
}

export interface EnumType {
  kind: 'enum';
  key: string;
  schema: string;
  name: string;
  values: string[];
  comment?: string;
  line: number;
}

export interface CompositeType {
  kind: 'composite';
  key: string;
  schema: string;
  name: string;
  fields: { name: string; type: string; typeRef: string; typeKey?: string }[];
  comment?: string;
  line: number;
}

export interface DomainType {
  kind: 'domain';
  key: string;
  schema: string;
  name: string;
  baseType: string;
  baseTypeRef: string;
  baseTypeKey?: string;
  notNull: boolean;
  defaultExpr?: string;
  checks: string[];
  comment?: string;
  line: number;
}

export interface RangeType {
  kind: 'range';
  key: string;
  schema: string;
  name: string;
  subtype: string;
  options: string[];
  comment?: string;
  line: number;
}

export interface BaseType {
  kind: 'basetype';
  key: string;
  schema: string;
  name: string;
  options: string[];
  comment?: string;
  line: number;
}

export interface View {
  kind: 'view';
  key: string;
  schema: string;
  name: string;
  materialized: boolean;
  columns: string[];
  dependsOn: string[];
  definition: string;
  comment?: string;
  line: number;
}

export interface MiscObject {
  kind: 'sequence' | 'function' | 'procedure' | 'trigger' | 'extension' | 'policy' | 'schema' | 'other';
  name: string;
  detail?: string;
  line: number;
}

export type TypeLike = EnumType | CompositeType | DomainType | RangeType | BaseType;
export type Entity = Table | View | TypeLike;

export interface ParseIssue {
  severity: 'error' | 'warning';
  message: string;
  line: number;
  column: number;
}

export interface Schema {
  tables: Map<string, Table>;
  views: Map<string, View>;
  types: Map<string, TypeLike>;
  misc: MiscObject[];
  schemas: string[];
  issues: ParseIssue[];
  statementCount: number;
  pgVersion?: number;
}

export function emptySchema(): Schema {
  return {
    tables: new Map(),
    views: new Map(),
    types: new Map(),
    misc: [],
    schemas: [],
    issues: [],
    statementCount: 0,
  };
}

export const keyOf = (schema: string, name: string) => `${schema}.${name}`;
