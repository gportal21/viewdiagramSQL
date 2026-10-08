import type { Edge, Node } from '@xyflow/react';
import type { Schema, Table, TypeLike, View } from '../schema/model';

export interface Visibility {
  hiddenSchemas: string[];
  showTypes: boolean;
  showViews: boolean;
  showTypeEdges: boolean;
}

export type TableNodeData = { kind: 'table'; table: Table; schemaColor: string; fkCols: string[]; typedCols: string[] };
export type TypeNodeData = { kind: 'type'; type: TypeLike; schemaColor: string };
export type ViewNodeData = { kind: 'view'; view: View; schemaColor: string };
export type EntityData = TableNodeData | TypeNodeData | ViewNodeData;
export type EntityNode = Node<EntityData & Record<string, unknown>>;

export type RelKind = 'fk' | 'type' | 'inherit' | 'partition' | 'view';
export interface RelData extends Record<string, unknown> {
  rel: RelKind;
  /** Columna de origen / destino (para elegir el handle de cada fila). */
  sourceCol?: string;
  targetCol?: string;
  label?: string;
  detail?: string;
  /** Lado "muchos" (FK no única). */
  many?: boolean;
  optional?: boolean;
  selfRef?: boolean;
}
export type RelEdge = Edge<RelData>;

// Colores por esquema: se asignan en orden y se reutilizan en ciclo.
const SCHEMA_COLORS = ['var(--schema-0)', 'var(--schema-1)', 'var(--schema-2)', 'var(--schema-3)', 'var(--schema-4)', 'var(--schema-5)'];

export function schemaColor(schemas: string[], schema: string): string {
  const i = schemas.indexOf(schema);
  return SCHEMA_COLORS[(i < 0 ? 0 : i) % SCHEMA_COLORS.length];
}

export const nodeId = {
  table: (k: string) => `t:${k}`,
  type: (k: string) => `y:${k}`,
  view: (k: string) => `v:${k}`,
};

export function buildGraph(schema: Schema, vis: Visibility): { nodes: EntityNode[]; edges: RelEdge[] } {
  const hidden = new Set(vis.hiddenSchemas);
  const nodes: EntityNode[] = [];
  const edges: RelEdge[] = [];
  const present = new Set<string>();

  for (const t of schema.tables.values()) {
    if (hidden.has(t.schema)) continue;
    const id = nodeId.table(t.key);
    present.add(id);
    nodes.push({
      id,
      type: 'table',
      position: { x: 0, y: 0 },
      data: {
        kind: 'table',
        table: t,
        schemaColor: schemaColor(schema.schemas, t.schema),
        fkCols: t.foreignKeys.flatMap((f) => f.columns),
        typedCols: t.columns.filter((c) => c.typeKey).map((c) => c.name),
      },
    });
  }
  if (vis.showTypes) {
    for (const ty of schema.types.values()) {
      if (hidden.has(ty.schema)) continue;
      const id = nodeId.type(ty.key);
      present.add(id);
      nodes.push({ id, type: 'type', position: { x: 0, y: 0 }, data: { kind: 'type', type: ty, schemaColor: schemaColor(schema.schemas, ty.schema) } });
    }
  }
  if (vis.showViews) {
    for (const v of schema.views.values()) {
      if (hidden.has(v.schema)) continue;
      const id = nodeId.view(v.key);
      present.add(id);
      nodes.push({ id, type: 'view', position: { x: 0, y: 0 }, data: { kind: 'view', view: v, schemaColor: schemaColor(schema.schemas, v.schema) } });
    }
  }

  for (const t of schema.tables.values()) {
    const src = nodeId.table(t.key);
    if (!present.has(src)) continue;

    t.foreignKeys.forEach((fk, i) => {
      const dst = nodeId.table(fk.refTable);
      if (!present.has(dst)) return;
      const cols = fk.columns.map((n) => t.columns.find((c) => c.name === n));
      // 1:1 si las columnas de la FK son exactamente la PK o tienen UNIQUE.
      const isPk = fk.columns.length === t.primaryKey.length && fk.columns.every((c) => t.primaryKey.includes(c));
      const isUnique =
        isPk ||
        (fk.columns.length === 1 && !!cols[0]?.unique) ||
        t.constraints.some((k) => k.kind === 'UNIQUE' && k.columns.length === fk.columns.length && fk.columns.every((c) => k.columns.includes(c))) ||
        t.indexes.some((x) => x.unique && !x.where && x.columns.length === fk.columns.length && fk.columns.every((c) => x.columns.includes(c)));
      const actions = [
        fk.onDelete !== 'NO ACTION' ? `ON DELETE ${fk.onDelete}` : '',
        fk.onUpdate !== 'NO ACTION' ? `ON UPDATE ${fk.onUpdate}` : '',
      ].filter(Boolean);
      edges.push({
        id: `fk:${t.key}:${i}`,
        source: src,
        target: dst,
        type: 'rel',
        data: {
          rel: 'fk',
          sourceCol: fk.columns[0],
          targetCol: fk.refColumns[0],
          many: !isUnique,
          optional: cols.some((c) => c?.nullable),
          selfRef: src === dst,
          label: fk.name ?? `${fk.columns.join(', ')} → ${fk.refTable.replace(/^public\./, '')}`,
          detail: [`(${fk.columns.join(', ')}) → (${fk.refColumns.join(', ')})`, ...actions].join(' · '),
        },
      });
    });

    for (const parent of t.inherits) {
      const dst = nodeId.table(parent);
      if (present.has(dst)) edges.push({ id: `inh:${t.key}:${parent}`, source: src, target: dst, type: 'rel', data: { rel: 'inherit', label: 'INHERITS' } });
    }
    if (t.partitionOf && present.has(nodeId.table(t.partitionOf))) {
      edges.push({
        id: `part:${t.key}`,
        source: src,
        target: nodeId.table(t.partitionOf),
        type: 'rel',
        data: { rel: 'partition', label: 'PARTITION OF', detail: t.partitionBound },
      });
    }
    if (vis.showTypes && vis.showTypeEdges) {
      for (const c of t.columns) {
        if (!c.typeKey) continue;
        const dst = nodeId.type(c.typeKey);
        if (!present.has(dst)) continue;
        edges.push({ id: `ty:${t.key}:${c.name}`, source: src, target: dst, type: 'rel', data: { rel: 'type', sourceCol: c.name, label: c.type } });
      }
    }
  }

  if (vis.showTypes && vis.showTypeEdges) {
    for (const ty of schema.types.values()) {
      const src = nodeId.type(ty.key);
      if (!present.has(src)) continue;
      const refs =
        ty.kind === 'composite' ? ty.fields.filter((f) => f.typeKey).map((f) => [f.name, f.typeKey!] as const)
        : ty.kind === 'domain' && ty.baseTypeKey ? [['', ty.baseTypeKey] as const]
        : [];
      for (const [col, key] of refs) {
        const dst = nodeId.type(key);
        if (present.has(dst) && dst !== src) edges.push({ id: `ty:${ty.key}:${col}`, source: src, target: dst, type: 'rel', data: { rel: 'type', sourceCol: col || undefined } });
      }
    }
  }

  if (vis.showViews) {
    for (const v of schema.views.values()) {
      const src = nodeId.view(v.key);
      if (!present.has(src)) continue;
      for (const dep of v.dependsOn) {
        const dst = schema.tables.has(dep) ? nodeId.table(dep) : nodeId.view(dep);
        if (present.has(dst)) edges.push({ id: `vw:${v.key}:${dep}`, source: src, target: dst, type: 'rel', data: { rel: 'view', label: 'usa' } });
      }
    }
  }

  return { nodes, edges };
}

// ───── tamaños estimados (para el layout antes de medir el DOM) ─────

const CHAR = 7.4; // px por carácter en IBM Plex Mono 12.5px aprox.
const ROW = 26;
const HEADER = 40;

export function estimateSize(n: EntityNode): { width: number; height: number } {
  const d = n.data;
  if (d.kind === 'table') {
    const rows = d.table.columns.map((c) => c.name.length + c.type.length + 6);
    const title = d.table.name.length + (d.table.schema !== 'public' ? d.table.schema.length + 1 : 0) + 6;
    const w = Math.max(title, ...rows, 22) * CHAR + 48;
    const extra = d.table.indexes.length ? 30 + d.table.indexes.length * 22 : 0;
    return { width: Math.min(Math.max(w, 230), 460), height: HEADER + Math.max(d.table.columns.length, 1) * ROW + extra + 8 };
  }
  if (d.kind === 'view') {
    const w = Math.max(d.view.name.length + 8, ...d.view.columns.map((c) => c.length + 2), 18) * CHAR + 40;
    return { width: Math.min(Math.max(w, 200), 420), height: HEADER + Math.max(d.view.columns.length, 1) * ROW + 8 };
  }
  const t = d.type;
  const lines =
    t.kind === 'enum' ? t.values.map((v) => v.length + 2)
    : t.kind === 'composite' ? t.fields.map((f) => f.name.length + f.type.length + 4)
    : t.kind === 'domain' ? [t.baseType.length + 6, ...t.checks.map((c) => Math.min(c.length, 44))]
    : t.kind === 'range' ? [t.subtype.length + 10, ...t.options.map((o) => o.length)]
    : t.options.map((o) => o.length);
  const count =
    t.kind === 'enum' ? t.values.length
    : t.kind === 'composite' ? t.fields.length
    : t.kind === 'domain' ? 1 + t.checks.length + (t.defaultExpr ? 1 : 0)
    : t.kind === 'range' ? 1 + t.options.length
    : t.options.length;
  const w = Math.max(t.name.length + 10, ...lines, 16) * CHAR + 36;
  return { width: Math.min(Math.max(w, 180), 380), height: HEADER + Math.max(count, 1) * 24 + 8 };
}
