// Convierte SQL de PostgreSQL en el modelo de esquema usando el parser real
// de Postgres (libpg_query compilado a WASM) y su deparser para expresiones.

import { parse as pgParse } from 'libpg-query';
import { deparseSync } from 'pgsql-deparser';
import {
  emptySchema,
  keyOf,
  type Column,
  type FkAction,
  type ForeignKey,
  type Schema,
  type Table,
  type TypeLike,
  type View,
} from './model';
import { Locator, charToByte, preprocess, splitStatements } from './split';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Node = any;

// ───────────────────────── helpers de AST ─────────────────────────

const str = (n: Node): string => n?.String?.sval ?? n?.sval ?? '';
const strList = (list: Node[] | undefined): string[] => (list ?? []).map(str);

function deparse(node: Node): string {
  if (!node) return '';
  try {
    return String(deparseSync(node))
      .replace(/\s+/g, ' ')
      .trim()
      // CAST('x' AS regclass) → 'x'::regclass, la forma habitual en Postgres.
      .replace(/CAST\(('(?:[^']|'')*'|-?[\w."]+) AS ([\w." ]+?(?:\([\d, ]*\))?(?:\[\])*)\)/g, '$1::$2')
      .replace(CATALOG_PREFIX, '');
  } catch {
    return '…';
  }
}

/** Deparsea un nodo envuelto (`{ TypeName: ... }`) o desnudo con su tipo. */
const dp = (type: string, node: Node) => (node ? deparse({ [type]: node }) : '');

const CATALOG_PREFIX = /\bpg_catalog\./g;

function typeInfo(typeName: Node): { type: string; typeRef: string; isArray: boolean } {
  const names = strList(typeName?.names);
  const clean = names[0] === 'pg_catalog' ? names.slice(1) : names;
  const display = dp('TypeName', typeName).replace(CATALOG_PREFIX, '') || clean.join('.');
  return {
    type: display,
    typeRef: clean.join('.'),
    isArray: Array.isArray(typeName?.arrayBounds) && typeName.arrayBounds.length > 0,
  };
}

const FK_ACTIONS: Record<string, FkAction> = {
  a: 'NO ACTION',
  r: 'RESTRICT',
  c: 'CASCADE',
  n: 'SET NULL',
  d: 'SET DEFAULT',
};
const MATCH: Record<string, ForeignKey['match']> = { f: 'FULL', p: 'PARTIAL', s: 'SIMPLE' };

interface RawRef {
  schema?: string;
  name: string;
  /** Esquema por defecto (search_path) vigente cuando se escribió la referencia. */
  ctx: string;
}

interface PendingFk {
  table: string;
  fk: Omit<ForeignKey, 'refTable'>;
  ref: RawRef;
}

interface PendingInherit {
  table: string;
  kind: 'inherits' | 'partition' | 'like';
  ref: RawRef;
}

// ───────────────────────── conversor ─────────────────────────

class Builder {
  schema: Schema = emptySchema();
  private defaultSchema = 'public';
  private schemaSet = new Set<string>(['public']);
  private pendingFks: PendingFk[] = [];
  private pendingInherits: PendingInherit[] = [];
  private pendingViewDeps = new Map<string, RawRef[]>();
  private line = 1;

  constructor(private locate: (byte: number) => { line: number; column: number }) {}

  // ── resolución de nombres ──
  private qualify(names: string[]): { schema: string; name: string } {
    if (names.length >= 2) {
      const schema = names[names.length - 2];
      this.schemaSet.add(schema);
      return { schema, name: names[names.length - 1] };
    }
    return { schema: this.defaultSchema, name: names[0] };
  }

  private rangeVar(rv: Node): { schema: string; name: string } {
    if (rv?.schemaname) this.schemaSet.add(rv.schemaname);
    return { schema: rv?.schemaname || this.defaultSchema, name: rv?.relname ?? '' };
  }

  private rawRef(rv: Node): RawRef {
    return { schema: rv?.schemaname || undefined, name: rv?.relname ?? '', ctx: this.defaultSchema };
  }

  private resolveIn<T>(map: Map<string, T>, ref: RawRef): string | undefined {
    if (ref.schema) {
      const k = keyOf(ref.schema, ref.name);
      return map.has(k) ? k : undefined;
    }
    for (const s of [ref.ctx, 'public']) {
      const k = keyOf(s, ref.name);
      if (map.has(k)) return k;
    }
    for (const k of map.keys()) if (k.endsWith('.' + ref.name) && k.slice(0, -ref.name.length - 1).indexOf('.') === -1) return k;
    return undefined;
  }

  private findTable(rv: Node): Table | undefined {
    const k = this.resolveIn(this.schema.tables, this.rawRef(rv));
    return k ? this.schema.tables.get(k) : undefined;
  }

  private findType(names: string[]): TypeLike | undefined {
    const clean = names[0] === 'pg_catalog' ? names.slice(1) : names;
    const ref: RawRef =
      clean.length >= 2
        ? { schema: clean[clean.length - 2], name: clean[clean.length - 1], ctx: this.defaultSchema }
        : { name: clean[0], ctx: this.defaultSchema };
    const k = this.resolveIn(this.schema.types, ref);
    return k ? this.schema.types.get(k) : undefined;
  }

  warn(message: string) {
    this.schema.issues.push({ severity: 'warning', message, line: this.line, column: 1 });
  }

  // ── entrada principal por sentencia ──
  statement(stmt: Node, byteLocation: number) {
    this.line = this.locate(byteLocation).line;
    this.schema.statementCount++;
    const [type] = Object.keys(stmt);
    const s = stmt[type];
    switch (type) {
      case 'CreateSchemaStmt': return this.createSchema(s, byteLocation);
      case 'VariableSetStmt': return this.setVar(s);
      case 'SelectStmt': return this.selectStmt(s);
      case 'CreateStmt': return this.createTable(s);
      case 'AlterTableStmt': return this.alterTable(s);
      case 'IndexStmt': return this.createIndex(s);
      case 'CreateEnumStmt': return this.createEnum(s);
      case 'AlterEnumStmt': return this.alterEnum(s);
      case 'CompositeTypeStmt': return this.createComposite(s);
      case 'CreateDomainStmt': return this.createDomain(s);
      case 'AlterDomainStmt': return this.alterDomain(s);
      case 'CreateRangeStmt': return this.createRange(s);
      case 'DefineStmt': return this.define(s);
      case 'ViewStmt': return this.createView(s);
      case 'CreateTableAsStmt': return this.createTableAs(s);
      case 'CommentStmt': return this.comment(s);
      case 'RenameStmt': return this.rename(s);
      case 'DropStmt': return this.drop(s);
      case 'CreateSeqStmt': {
        const { schema, name } = this.rangeVar(s.sequence);
        this.schema.misc.push({ kind: 'sequence', name: keyOf(schema, name), line: this.line });
        return;
      }
      case 'CreateFunctionStmt': {
        const { schema, name } = this.qualify(strList(s.funcname));
        const args = (s.parameters ?? [])
          .map((p: Node) => p.FunctionParameter)
          .filter((p: Node) => p && p.mode !== 'FUNC_PARAM_TABLE' && p.mode !== 'FUNC_PARAM_OUT')
          .map((p: Node) => typeInfo(p.argType).type);
        const ret = s.returnType ? typeInfo(s.returnType).type : '';
        this.schema.misc.push({
          kind: s.is_procedure ? 'procedure' : 'function',
          name: `${keyOf(schema, name)}(${args.join(', ')})`,
          detail: ret ? `→ ${ret}` : undefined,
          line: this.line,
        });
        return;
      }
      case 'CreateTrigStmt': {
        const t = this.findTable(s.relation);
        const fn = strList(s.funcname).join('.');
        if (t) t.triggers.push(`${s.trigname} → ${fn}()`);
        this.schema.misc.push({ kind: 'trigger', name: s.trigname, detail: `on ${s.relation?.relname} → ${fn}()`, line: this.line });
        return;
      }
      case 'CreatePolicyStmt': {
        const t = this.findTable(s.table);
        if (t) t.policies.push(`${s.policy_name} (${String(s.cmd_name ?? 'all').toUpperCase()})`);
        this.schema.misc.push({ kind: 'policy', name: s.policy_name, detail: `on ${s.table?.relname}`, line: this.line });
        return;
      }
      case 'CreateExtensionStmt':
        this.schema.misc.push({ kind: 'extension', name: s.extname, line: this.line });
        return;
      default:
        // GRANT, OWNER TO, SET, BEGIN/COMMIT, INSERT, etc.: válidos pero no afectan al diagrama.
        return;
    }
  }

  // ── schemas y search_path ──
  private createSchema(s: Node, byteLocation: number) {
    const name = s.schemaname ?? s.authrole?.RoleSpec?.rolename;
    if (name) {
      this.schemaSet.add(name);
      this.schema.misc.push({ kind: 'schema', name, line: this.line });
    }
    if (s.schemaElts?.length) {
      const prev = this.defaultSchema;
      this.defaultSchema = name ?? prev;
      for (const el of s.schemaElts) this.statement(el, byteLocation);
      this.schema.statementCount -= s.schemaElts.length;
      this.defaultSchema = prev;
    }
  }

  private setSearchPath(values: string[]) {
    const first = values.map((v) => v.trim()).find((v) => v && v !== '"$user"' && v !== '$user');
    // search_path vacío (pg_dump) → todo viene calificado; mantenemos public por defecto.
    this.defaultSchema = first ?? 'public';
  }

  private setVar(s: Node) {
    if (s.name !== 'search_path' || s.kind !== 'VAR_SET_VALUE') return;
    this.setSearchPath((s.args ?? []).map((a: Node) => a.A_Const?.sval?.sval ?? ''));
  }

  private selectStmt(s: Node) {
    // SELECT pg_catalog.set_config('search_path', 'x', false) — típico de pg_dump.
    const fc = s.targetList?.[0]?.ResTarget?.val?.FuncCall;
    if (!fc) return;
    const fname = strList(fc.funcname).join('.');
    if (!/(^|\.)set_config$/.test(fname)) return;
    const [k, v] = (fc.args ?? []).map((a: Node) => a.A_Const?.sval?.sval);
    if (k === 'search_path' && typeof v === 'string') this.setSearchPath(v.split(','));
  }

  // ── columnas y constraints ──
  private column(def: Node): Column {
    const ti = typeInfo(def.typeName);
    const col: Column = {
      name: def.colname,
      type: ti.type,
      typeRef: ti.typeRef,
      isArray: ti.isArray,
      nullable: !def.is_not_null,
      primaryKey: false,
      unique: false,
      checks: [],
    };
    if (/^(big|small)?serial[248]?$/.test(ti.typeRef)) col.nullable = false;
    if (def.collClause) col.collation = strList(def.collClause.collname).join('.');
    return col;
  }

  private applyColumnConstraints(table: Table, col: Column, constraints: Node[] | undefined) {
    for (const c of constraints ?? []) {
      const k = c.Constraint;
      if (!k) continue;
      switch (k.contype) {
        case 'CONSTR_NOTNULL': col.nullable = false; break;
        case 'CONSTR_NULL': col.nullable = true; break;
        case 'CONSTR_DEFAULT': col.defaultExpr = deparse(k.raw_expr); break;
        case 'CONSTR_PRIMARY':
          col.primaryKey = true;
          col.nullable = false;
          table.primaryKey = [col.name];
          break;
        case 'CONSTR_UNIQUE': col.unique = true; break;
        case 'CONSTR_CHECK': col.checks.push(deparse(k.raw_expr)); break;
        case 'CONSTR_IDENTITY':
          col.identity = k.generated_when === 'a' ? 'ALWAYS' : 'BY DEFAULT';
          col.nullable = false;
          break;
        case 'CONSTR_GENERATED': col.generated = deparse(k.raw_expr); break;
        case 'CONSTR_FOREIGN':
          this.pendingFks.push({
            table: table.key,
            ref: this.rawRef(k.pktable),
            fk: {
              name: k.conname,
              columns: [col.name],
              refColumns: strList(k.pk_attrs),
              onDelete: FK_ACTIONS[k.fk_del_action] ?? 'NO ACTION',
              onUpdate: FK_ACTIONS[k.fk_upd_action] ?? 'NO ACTION',
              match: MATCH[k.fk_matchtype],
              deferrable: !!k.deferrable,
            },
          });
          break;
        default:
          break;
      }
    }
  }

  private tableConstraint(table: Table, k: Node) {
    switch (k.contype) {
      case 'CONSTR_PRIMARY': {
        const cols = strList(k.keys);
        table.primaryKey = cols;
        for (const c of table.columns) if (cols.includes(c.name)) { c.primaryKey = true; c.nullable = false; }
        table.constraints.push({ name: k.conname, kind: 'PRIMARY KEY', columns: cols });
        break;
      }
      case 'CONSTR_UNIQUE': {
        const cols = strList(k.keys);
        if (cols.length === 1) {
          const c = table.columns.find((x) => x.name === cols[0]);
          if (c) c.unique = true;
        }
        table.constraints.push({ name: k.conname, kind: 'UNIQUE', columns: cols, expr: k.nulls_not_distinct ? 'NULLS NOT DISTINCT' : undefined });
        break;
      }
      case 'CONSTR_CHECK':
        table.constraints.push({ name: k.conname, kind: 'CHECK', columns: [], expr: deparse(k.raw_expr) });
        break;
      case 'CONSTR_EXCLUSION': {
        const parts = (k.exclusions ?? []).map((ex: Node) => {
          const [elem, ops] = ex.List?.items ?? [];
          const e = elem?.IndexElem;
          const target = e?.name ?? deparse(e?.expr);
          return `${target} WITH ${strList(ops?.List?.items).join(' ')}`;
        });
        table.constraints.push({
          name: k.conname,
          kind: 'EXCLUDE',
          columns: [],
          expr: `USING ${k.access_method ?? 'gist'} (${parts.join(', ')})`,
        });
        break;
      }
      case 'CONSTR_FOREIGN':
        this.pendingFks.push({
          table: table.key,
          ref: this.rawRef(k.pktable),
          fk: {
            name: k.conname,
            columns: strList(k.fk_attrs),
            refColumns: strList(k.pk_attrs),
            onDelete: FK_ACTIONS[k.fk_del_action] ?? 'NO ACTION',
            onUpdate: FK_ACTIONS[k.fk_upd_action] ?? 'NO ACTION',
            match: MATCH[k.fk_matchtype],
            deferrable: !!k.deferrable,
          },
        });
        break;
      case 'CONSTR_NOTNULL': {
        // PG 18: NOT NULL como constraint de tabla.
        for (const name of strList(k.keys)) {
          const c = table.columns.find((x) => x.name === name);
          if (c) c.nullable = false;
        }
        break;
      }
      default:
        break;
    }
  }

  // ── CREATE TABLE ──
  private createTable(s: Node) {
    const { schema, name } = this.rangeVar(s.relation);
    const key = keyOf(schema, name);
    if (this.schema.tables.has(key) && !s.if_not_exists) this.warn(`La tabla ${key} se define más de una vez; se usa la última definición.`);
    if (this.schema.tables.has(key) && s.if_not_exists) return;
    const table: Table = {
      kind: 'table',
      key,
      schema,
      name,
      columns: [],
      primaryKey: [],
      foreignKeys: [],
      constraints: [],
      indexes: [],
      triggers: [],
      policies: [],
      persistence: s.relation?.relpersistence === 'u' ? 'unlogged' : s.relation?.relpersistence === 't' ? 'temporary' : 'permanent',
      inherits: [],
      line: this.line,
    };
    this.schema.tables.set(key, table);

    const isPartition = !!s.partbound;
    for (const rv of s.inhRelations ?? []) {
      const r = rv.RangeVar;
      const ref = this.rawRef(r);
      this.pendingInherits.push({ table: key, kind: isPartition ? 'partition' : 'inherits', ref });
    }
    if (isPartition) table.partitionBound = this.partitionBound(s.partbound);
    if (s.partspec) {
      const strat = String(s.partspec.strategy ?? '').replace('PARTITION_STRATEGY_', '');
      const params = (s.partspec.partParams ?? []).map((p: Node) => p.PartitionElem?.name ?? deparse(p.PartitionElem?.expr));
      table.partitionBy = `${strat} (${params.join(', ')})`;
    }
    if (s.ofTypename) {
      // Tabla tipada: sus columnas son las del tipo compuesto en este momento.
      const ty = this.findType(strList(s.ofTypename.names));
      table.ofType = ty?.key ?? typeInfo(s.ofTypename).typeRef;
      if (ty?.kind === 'composite') {
        for (const f of ty.fields) {
          table.columns.push({ name: f.name, type: f.type, typeRef: f.typeRef, isArray: /\[\]$/.test(f.type), nullable: true, primaryKey: false, unique: false, checks: [], inherited: true });
        }
      } else this.warn(`${key} es OF ${table.ofType}, pero ese tipo compuesto no está definido.`);
    }

    const tableLevel: Node[] = [];
    for (const el of s.tableElts ?? []) {
      if (el.ColumnDef) {
        // En tablas OF type / PARTITION OF las ColumnDef sin tipo sólo añaden constraints.
        if (!el.ColumnDef.typeName) {
          tableLevel.push({ __colOptions: el.ColumnDef });
          continue;
        }
        const col = this.column(el.ColumnDef);
        table.columns.push(col);
        this.applyColumnConstraints(table, col, el.ColumnDef.constraints);
      } else if (el.Constraint) {
        tableLevel.push(el.Constraint);
      } else if (el.TableLikeClause) {
        this.pendingInherits.push({ table: key, kind: 'like', ref: this.rawRef(el.TableLikeClause.relation) });
      }
    }
    // Las constraints de tabla se aplican tras columnas heredadas (en finalize) si hace falta.
    (table as Table & { __pending?: Node[] }).__pending = tableLevel;
    if (!this.pendingInherits.some((p) => p.table === key)) this.flushTableLevel(table);
  }

  private flushTableLevel(table: Table) {
    const t = table as Table & { __pending?: Node[] };
    for (const k of t.__pending ?? []) {
      if (k.__colOptions) {
        const def = k.__colOptions;
        const col = table.columns.find((c) => c.name === def.colname);
        if (col) this.applyColumnConstraints(table, col, def.constraints);
      } else this.tableConstraint(table, k);
    }
    delete t.__pending;
  }

  private partitionBound(b: Node): string {
    if (!b) return '';
    if (b.is_default) return 'DEFAULT';
    const list = (xs: Node[] | undefined) => (xs ?? []).map((x) => deparse(x)).join(', ');
    switch (b.strategy) {
      case 'l': return `IN (${list(b.listdatums)})`;
      case 'r': return `FROM (${list(b.lowerdatums)}) TO (${list(b.upperdatums)})`;
      case 'h': return `WITH (MODULUS ${b.modulus}, REMAINDER ${b.remainder ?? 0})`;
      default: return '';
    }
  }

  // ── ALTER TABLE ──
  private alterTable(s: Node) {
    if (s.objtype && s.objtype !== 'OBJECT_TABLE' && s.objtype !== 'OBJECT_FOREIGN_TABLE') return;
    const table = this.findTable(s.relation);
    if (!table) {
      const relevant = (s.cmds ?? []).some((c: Node) =>
        ['AT_AddColumn', 'AT_AddConstraint', 'AT_AlterColumnType'].includes(c.AlterTableCmd?.subtype),
      );
      if (relevant && !s.missing_ok) this.warn(`ALTER TABLE sobre una tabla no definida: ${s.relation?.relname}`);
      return;
    }
    for (const c of s.cmds ?? []) {
      const cmd = c.AlterTableCmd;
      if (!cmd) continue;
      const col = cmd.name ? table.columns.find((x) => x.name === cmd.name) : undefined;
      switch (cmd.subtype) {
        case 'AT_AddColumn': {
          const def = cmd.def?.ColumnDef;
          if (!def) break;
          if (table.columns.some((x) => x.name === def.colname)) {
            if (!cmd.missing_ok) this.warn(`La columna ${def.colname} ya existe en ${table.key}.`);
            break;
          }
          const nc = this.column(def);
          table.columns.push(nc);
          this.applyColumnConstraints(table, nc, def.constraints);
          break;
        }
        case 'AT_DropColumn':
          table.columns = table.columns.filter((x) => x.name !== cmd.name);
          table.foreignKeys = table.foreignKeys.filter((f) => !f.columns.includes(cmd.name));
          this.pendingFks = this.pendingFks.filter((p) => !(p.table === table.key && p.fk.columns.includes(cmd.name)));
          break;
        case 'AT_AddConstraint':
          if (cmd.def?.Constraint) this.tableConstraint(table, cmd.def.Constraint);
          break;
        case 'AT_DropConstraint': {
          const n = cmd.name;
          table.constraints = table.constraints.filter((x) => x.name !== n);
          table.foreignKeys = table.foreignKeys.filter((x) => x.name !== n);
          this.pendingFks = this.pendingFks.filter((p) => !(p.table === table.key && p.fk.name === n));
          break;
        }
        case 'AT_ColumnDefault':
          if (col) col.defaultExpr = cmd.def ? deparse(cmd.def) : undefined;
          break;
        case 'AT_SetNotNull': if (col) col.nullable = false; break;
        case 'AT_DropNotNull': if (col) col.nullable = true; break;
        case 'AT_AlterColumnType':
          if (col && cmd.def?.ColumnDef?.typeName) {
            const ti = typeInfo(cmd.def.ColumnDef.typeName);
            col.type = ti.type;
            col.typeRef = ti.typeRef;
            col.isArray = ti.isArray;
          }
          break;
        case 'AT_AddIdentity':
          if (col && cmd.def?.Constraint) {
            col.identity = cmd.def.Constraint.generated_when === 'a' ? 'ALWAYS' : 'BY DEFAULT';
            col.nullable = false;
          }
          break;
        case 'AT_DropIdentity': if (col) col.identity = undefined; break;
        case 'AT_EnableRowSecurity':
        case 'AT_ForceRowSecurity':
          table.rls = true;
          break;
        case 'AT_DisableRowSecurity': table.rls = false; break;
        case 'AT_AddInherit':
          if (cmd.def?.RangeVar) this.pendingInherits.push({ table: table.key, kind: 'inherits', ref: this.rawRef(cmd.def.RangeVar) });
          break;
        case 'AT_AttachPartition': {
          const pc = cmd.def?.PartitionCmd;
          const child = pc && this.findTable(pc.name);
          if (child) {
            child.partitionOf = table.key;
            child.partitionBound = this.partitionBound(pc.bound);
          }
          break;
        }
        default:
          break;
      }
    }
  }

  // ── índices ──
  private createIndex(s: Node) {
    const table = this.findTable(s.relation);
    if (!table) return;
    const cols = (s.indexParams ?? []).map((p: Node) => {
      const e = p.IndexElem;
      const base = e?.name ?? `(${deparse(e?.expr)})`;
      return e?.ordering === 'SORTBY_DESC' ? `${base} DESC` : base;
    });
    table.indexes.push({
      name: s.idxname,
      columns: cols,
      unique: !!s.unique,
      primary: !!s.primary,
      method: s.accessMethod && s.accessMethod !== 'btree' ? s.accessMethod : undefined,
      where: s.whereClause ? deparse(s.whereClause) : undefined,
      include: (s.indexIncludingParams ?? []).map((p: Node) => p.IndexElem?.name).filter(Boolean),
    });
    if (s.unique && cols.length === 1 && !s.whereClause) {
      const c = table.columns.find((x) => x.name === cols[0]);
      if (c) c.unique = true;
    }
  }

  // ── tipos ──
  private addType(t: TypeLike) {
    if (this.schema.types.has(t.key)) this.warn(`El tipo ${t.key} se define más de una vez.`);
    this.schema.types.set(t.key, t);
  }

  private createEnum(s: Node) {
    const { schema, name } = this.qualify(strList(s.typeName));
    this.addType({ kind: 'enum', key: keyOf(schema, name), schema, name, values: strList(s.vals), line: this.line });
  }

  private alterEnum(s: Node) {
    const t = this.findType(strList(s.typeName));
    if (!t || t.kind !== 'enum') return;
    if (s.oldVal) {
      t.values = t.values.map((v) => (v === s.oldVal ? s.newVal : v));
      return;
    }
    if (t.values.includes(s.newVal)) return;
    const idx = s.newValNeighbor ? t.values.indexOf(s.newValNeighbor) : -1;
    if (idx === -1) t.values.push(s.newVal);
    else t.values.splice(s.newValIsAfter ? idx + 1 : idx, 0, s.newVal);
  }

  private createComposite(s: Node) {
    const { schema, name } = this.rangeVar(s.typevar);
    this.addType({
      kind: 'composite',
      key: keyOf(schema, name),
      schema,
      name,
      fields: (s.coldeflist ?? []).map((c: Node) => {
        const ti = typeInfo(c.ColumnDef?.typeName);
        return { name: c.ColumnDef?.colname, type: ti.type, typeRef: ti.typeRef };
      }),
      line: this.line,
    });
  }

  private createDomain(s: Node) {
    const { schema, name } = this.qualify(strList(s.domainname));
    const ti = typeInfo(s.typeName);
    const checks: string[] = [];
    let notNull = false;
    let defaultExpr: string | undefined;
    for (const c of s.constraints ?? []) {
      const k = c.Constraint;
      if (k?.contype === 'CONSTR_CHECK') checks.push(deparse(k.raw_expr));
      else if (k?.contype === 'CONSTR_NOTNULL') notNull = true;
      else if (k?.contype === 'CONSTR_DEFAULT') defaultExpr = deparse(k.raw_expr);
    }
    this.addType({ kind: 'domain', key: keyOf(schema, name), schema, name, baseType: ti.type, baseTypeRef: ti.typeRef, notNull, defaultExpr, checks, line: this.line });
  }

  private alterDomain(s: Node) {
    const t = this.findType(strList(s.typeName));
    if (!t || t.kind !== 'domain') return;
    if (s.subtype === 'C' && s.def?.Constraint?.contype === 'CONSTR_CHECK') t.checks.push(deparse(s.def.Constraint.raw_expr));
    if (s.subtype === 'O') t.notNull = true;
    if (s.subtype === 'N') t.notNull = false;
    if (s.subtype === 'T') t.defaultExpr = s.def ? deparse(s.def) : undefined;
  }

  private defElems(list: Node[] | undefined): string[] {
    return (list ?? []).map((d: Node) => {
      const e = d.DefElem;
      const arg = e?.arg;
      let v = '';
      if (arg?.TypeName) v = typeInfo(arg.TypeName).type;
      else if (arg?.List) v = strList(arg.List.items).join('.');
      else if (arg) v = deparse(arg).replace(/^'(.*)'$/, '$1') || str(arg);
      return v ? `${e.defname} = ${v}` : e.defname;
    });
  }

  private createRange(s: Node) {
    const { schema, name } = this.qualify(strList(s.typeName));
    const opts = this.defElems(s.params);
    const sub = opts.find((o) => o.startsWith('subtype ='))?.slice(10) ?? '?';
    this.addType({ kind: 'range', key: keyOf(schema, name), schema, name, subtype: sub, options: opts.filter((o) => !o.startsWith('subtype =')), line: this.line });
  }

  private define(s: Node) {
    if (s.kind !== 'OBJECT_TYPE') {
      this.schema.misc.push({ kind: 'other', name: strList(s.defnames).join('.'), detail: String(s.kind).replace('OBJECT_', '').toLowerCase(), line: this.line });
      return;
    }
    const { schema, name } = this.qualify(strList(s.defnames));
    if (!s.definition) return; // CREATE TYPE foo; (shell type)
    this.addType({ kind: 'basetype', key: keyOf(schema, name), schema, name, options: this.defElems(s.definition), line: this.line });
  }

  // ── vistas ──
  private viewColumns(query: Node, aliases: string[]): string[] {
    if (aliases.length) return aliases;
    let sel = query?.SelectStmt;
    while (sel && sel.op && sel.op !== 'SETOP_NONE') sel = sel.larg;
    if (sel?.valuesLists) return sel.valuesLists[0]?.List?.items.map((_: Node, i: number) => `column${i + 1}`) ?? [];
    return (sel?.targetList ?? []).map((t: Node) => {
      const r = t.ResTarget;
      if (r?.name) return r.name;
      const v = r?.val;
      if (v?.ColumnRef) {
        const f = v.ColumnRef.fields;
        const last = f[f.length - 1];
        return last?.A_Star ? (f.length > 1 ? `${str(f[f.length - 2])}.*` : '*') : str(last);
      }
      if (v?.FuncCall) return strList(v.FuncCall.funcname).slice(-1)[0];
      if (v?.TypeCast?.arg?.ColumnRef) return str(v.TypeCast.arg.ColumnRef.fields.slice(-1)[0]);
      return '?column?';
    });
  }

  private collectRelations(node: Node, out: RawRef[], ctes: Set<string>) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const n of node) this.collectRelations(n, out, ctes);
      return;
    }
    if (node.withClause?.ctes) for (const c of node.withClause.ctes) ctes.add(c.CommonTableExpr?.ctename);
    if (node.RangeVar) {
      const rv = node.RangeVar;
      if (!(ctes.has(rv.relname) && !rv.schemaname)) out.push(this.rawRef(rv));
      return;
    }
    for (const k of Object.keys(node)) this.collectRelations(node[k], out, ctes);
  }

  private addView(rv: Node, query: Node, aliases: string[], materialized: boolean) {
    const { schema, name } = this.rangeVar(rv);
    const key = keyOf(schema, name);
    const refs: RawRef[] = [];
    this.collectRelations(query, refs, new Set());
    const view: View = {
      kind: 'view',
      key,
      schema,
      name,
      materialized,
      columns: this.viewColumns(query, aliases),
      dependsOn: [],
      definition: deparse(query),
      line: this.line,
    };
    this.schema.views.set(key, view);
    this.pendingViewDeps.set(key, refs);
  }

  private createView(s: Node) {
    this.addView(s.view, s.query, strList(s.aliases), false);
  }

  private createTableAs(s: Node) {
    const rel = s.into?.rel;
    const aliases = strList(s.into?.colNames);
    if (s.objtype === 'OBJECT_MATVIEW') this.addView(rel, s.query, aliases, true);
    else {
      // CREATE TABLE x AS SELECT ... → tabla con columnas sin tipo conocido.
      const { schema, name } = this.rangeVar(rel);
      const key = keyOf(schema, name);
      this.schema.tables.set(key, {
        kind: 'table', key, schema, name,
        columns: this.viewColumns(s.query, aliases).map((n) => ({ name: n, type: '(AS SELECT)', typeRef: '', isArray: false, nullable: true, primaryKey: false, unique: false, checks: [] })),
        primaryKey: [], foreignKeys: [], constraints: [], indexes: [], triggers: [], policies: [],
        persistence: rel?.relpersistence === 'u' ? 'unlogged' : rel?.relpersistence === 't' ? 'temporary' : 'permanent',
        inherits: [], line: this.line,
      });
    }
  }

  // ── COMMENT ON ──
  private comment(s: Node) {
    const text: string | undefined = s.comment ?? undefined;
    const obj = s.object;
    switch (s.objtype) {
      case 'OBJECT_TABLE':
      case 'OBJECT_FOREIGN_TABLE': {
        const names = strList(obj?.List?.items);
        const t = this.findTable({ schemaname: names.length > 1 ? names[0] : undefined, relname: names[names.length - 1] });
        if (t) t.comment = text;
        break;
      }
      case 'OBJECT_VIEW':
      case 'OBJECT_MATVIEW': {
        const names = strList(obj?.List?.items);
        const k = this.resolveIn(this.schema.views, { schema: names.length > 1 ? names[0] : undefined, name: names[names.length - 1], ctx: this.defaultSchema });
        if (k) this.schema.views.get(k)!.comment = text;
        break;
      }
      case 'OBJECT_COLUMN': {
        const names = strList(obj?.List?.items);
        const colName = names.pop()!;
        const t = this.findTable({ schemaname: names.length > 1 ? names[0] : undefined, relname: names[names.length - 1] });
        const c = t?.columns.find((x) => x.name === colName);
        if (c) c.comment = text;
        break;
      }
      case 'OBJECT_TYPE':
      case 'OBJECT_DOMAIN': {
        const t = this.findType(strList(obj?.TypeName?.names));
        if (t) t.comment = text;
        break;
      }
      default:
        break;
    }
  }

  // ── RENAME ──
  private rename(s: Node) {
    if (s.renameType === 'OBJECT_TABLE' && s.relation) {
      const t = this.findTable(s.relation);
      if (!t) return;
      const oldKey = t.key;
      this.schema.tables.delete(oldKey);
      t.name = s.newname;
      t.key = keyOf(t.schema, t.name);
      this.schema.tables.set(t.key, t);
      for (const p of this.pendingFks) {
        if (p.table === oldKey) p.table = t.key;
        if (this.resolveIn(new Map([[oldKey, 1]]), p.ref) === oldKey) p.ref = { schema: t.schema, name: t.name, ctx: p.ref.ctx };
      }
      for (const p of this.pendingInherits) if (p.table === oldKey) p.table = t.key;
    } else if (s.renameType === 'OBJECT_COLUMN' && s.relation) {
      const t = this.findTable(s.relation);
      const c = t?.columns.find((x) => x.name === s.subname);
      if (!t || !c) return;
      c.name = s.newname;
      t.primaryKey = t.primaryKey.map((n) => (n === s.subname ? s.newname : n));
      for (const p of this.pendingFks) {
        if (p.table === t.key) p.fk.columns = p.fk.columns.map((n) => (n === s.subname ? s.newname : n));
        if (this.resolveIn(new Map([[t.key, 1]]), p.ref) === t.key) p.fk.refColumns = p.fk.refColumns.map((n) => (n === s.subname ? s.newname : n));
      }
    } else if (s.renameType === 'OBJECT_TYPE' || s.renameType === 'OBJECT_DOMAIN') {
      const names = s.object?.List ? strList(s.object.List.items) : strList(s.object?.TypeName?.names);
      const t = this.findType(names);
      if (!t) return;
      this.schema.types.delete(t.key);
      t.name = s.newname;
      t.key = keyOf(t.schema, t.name);
      this.schema.types.set(t.key, t);
    }
  }

  // ── DROP ──
  private drop(s: Node) {
    for (const o of s.objects ?? []) {
      if (s.removeType === 'OBJECT_TABLE') {
        const names = strList(o.List?.items);
        const k = this.resolveIn(this.schema.tables, { schema: names.length > 1 ? names[0] : undefined, name: names[names.length - 1], ctx: this.defaultSchema });
        if (k) {
          this.schema.tables.delete(k);
          this.pendingFks = this.pendingFks.filter((p) => p.table !== k);
        }
      } else if (s.removeType === 'OBJECT_VIEW' || s.removeType === 'OBJECT_MATVIEW') {
        const names = strList(o.List?.items);
        const k = this.resolveIn(this.schema.views, { schema: names.length > 1 ? names[0] : undefined, name: names[names.length - 1], ctx: this.defaultSchema });
        if (k) this.schema.views.delete(k);
      } else if (s.removeType === 'OBJECT_TYPE' || s.removeType === 'OBJECT_DOMAIN') {
        const t = this.findType(strList(o.TypeName?.names));
        if (t) this.schema.types.delete(t.key);
      }
    }
  }

  // ── resolución final ──
  finalize(): Schema {
    const S = this.schema;

    // 1) Herencia, particiones, LIKE y OF type: copiar columnas en orden.
    const done = new Set<string>();
    const byTable = new Map<string, PendingInherit[]>();
    for (const p of this.pendingInherits) byTable.set(p.table, [...(byTable.get(p.table) ?? []), p]);
    const resolveTable = (key: string, stack = new Set<string>()) => {
      if (done.has(key) || stack.has(key)) return;
      stack.add(key);
      const t = S.tables.get(key);
      const list = byTable.get(key) ?? [];
      if (!t) return;
      const inheritedCols: Column[] = [];
      for (const p of list) {
        const parentKey = this.resolveIn(S.tables, p.ref);
        if (!parentKey) {
          this.schema.issues.push({ severity: 'warning', message: `${t.key} hace referencia a la tabla ${p.ref.schema ? p.ref.schema + '.' : ''}${p.ref.name}, que no está definida.`, line: t.line, column: 1 });
          continue;
        }
        resolveTable(parentKey, stack);
        const parent = S.tables.get(parentKey)!;
        if (p.kind === 'partition') t.partitionOf = parentKey;
        if (p.kind === 'inherits') t.inherits.push(parentKey);
        for (const c of parent.columns) {
          if (inheritedCols.some((x) => x.name === c.name) || t.columns.some((x) => x.name === c.name && p.kind !== 'like')) continue;
          inheritedCols.push({
            ...c,
            primaryKey: p.kind === 'partition' ? c.primaryKey : false,
            unique: p.kind === 'partition' ? c.unique : false,
            checks: [...c.checks],
            inherited: p.kind !== 'like',
          });
        }
        if (p.kind === 'partition' && !t.primaryKey.length) t.primaryKey = [...parent.primaryKey];
      }
      // Columnas propias con el mismo nombre se fusionan con las heredadas.
      const own = t.columns.filter((c) => !inheritedCols.some((x) => x.name === c.name));
      for (const c of t.columns) {
        const ic = inheritedCols.find((x) => x.name === c.name);
        if (ic) Object.assign(ic, { ...c, inherited: false });
      }
      t.columns = [...inheritedCols, ...own];
      this.flushTableLevel(t);
      done.add(key);
    };
    for (const key of [...S.tables.keys()]) resolveTable(key);

    // 2) Claves foráneas.
    for (const p of this.pendingFks) {
      const t = S.tables.get(p.table);
      if (!t) continue;
      const refKey = this.resolveIn(S.tables, p.ref);
      const target = refKey ? S.tables.get(refKey) : undefined;
      const refColumns = p.fk.refColumns.length ? p.fk.refColumns : target?.primaryKey ?? [];
      t.foreignKeys.push({
        ...p.fk,
        refTable: refKey ?? keyOf(p.ref.schema ?? p.ref.ctx, p.ref.name),
        refColumns,
        unresolved: !target,
      });
      if (!target) {
        S.issues.push({ severity: 'warning', message: `La FK ${p.fk.name ?? ''} de ${t.key} apunta a ${p.ref.name}, que no está definida.`.replace('  ', ' '), line: t.line, column: 1 });
      }
    }

    // 3) Tipos de columnas → tipos de usuario.
    const typeKeyOf = (ref: string) => {
      if (!ref) return undefined;
      const parts = ref.split('.');
      const k = this.resolveIn(S.types, parts.length > 1 ? { schema: parts[0], name: parts[1], ctx: 'public' } : { name: parts[0], ctx: 'public' });
      return k;
    };
    for (const t of S.tables.values()) for (const c of t.columns) c.typeKey = typeKeyOf(c.typeRef);
    for (const ty of S.types.values()) {
      if (ty.kind === 'composite') for (const f of ty.fields) f.typeKey = typeKeyOf(f.typeRef);
      if (ty.kind === 'domain') ty.baseTypeKey = typeKeyOf(ty.baseTypeRef);
    }

    // 4) Dependencias de vistas.
    for (const [key, refs] of this.pendingViewDeps) {
      const v = S.views.get(key);
      if (!v) continue;
      const deps = new Set<string>();
      for (const r of refs) {
        const k = this.resolveIn(S.tables, r) ?? this.resolveIn(S.views, r);
        if (k && k !== key) deps.add(k);
      }
      v.dependsOn = [...deps];
    }

    const used = new Set<string>();
    for (const t of S.tables.values()) used.add(t.schema);
    for (const v of S.views.values()) used.add(v.schema);
    for (const ty of S.types.values()) used.add(ty.schema);
    S.schemas = [...used].sort((a, b) => (a === 'public' ? -1 : b === 'public' ? 1 : a.localeCompare(b)));
    S.issues.sort((a, b) => a.line - b.line);
    return S;
  }
}

// ───────────────────────── API pública ─────────────────────────

interface PgError extends Error {
  sqlDetails?: { cursorPosition?: number };
}

export async function parseSql(input: string): Promise<Schema> {
  const sql = preprocess(input);
  const locator = new Locator(sql);
  const builder = new Builder((b) => locator.at(locator.skipTrivia(b)));

  if (!sql.trim()) return builder.finalize();

  try {
    const result = await pgParse(sql);
    builder.schema.pgVersion = result.version;
    for (const raw of result.stmts ?? []) builder.statement(raw.stmt, raw.stmt_location ?? 0);
    return builder.finalize();
  } catch {
    // Hay al menos un error de sintaxis: parseamos sentencia por sentencia para
    // dibujar todo lo válido y señalar exactamente qué falla y dónde.
  }

  const issues: Schema['issues'] = [];
  for (const seg of splitStatements(sql)) {
    const segByte = charToByte(sql, seg.start);
    try {
      const result = await pgParse(seg.text);
      builder.schema.pgVersion = result.version;
      for (const raw of result.stmts ?? []) builder.statement(raw.stmt, segByte + (raw.stmt_location ?? 0));
    } catch (e) {
      const err = e as PgError;
      const cursor = err.sqlDetails?.cursorPosition;
      // cursorPosition de libpg_query es base 0 en bytes dentro del segmento.
      const at = locator.at(segByte + (typeof cursor === 'number' && cursor >= 0 ? cursor : leadingWs(seg.text)));
      issues.push({ severity: 'error', message: err.message || 'Error de sintaxis', line: at.line, column: at.column });
    }
  }
  const schema = builder.finalize();
  schema.issues = [...issues, ...schema.issues].sort((a, b) => a.line - b.line || (a.severity === 'error' ? -1 : 1));
  return schema;
}

function leadingWs(text: string): number {
  const m = /^(\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)*/.exec(text);
  return m ? new TextEncoder().encode(m[0]).length : 0;
}
