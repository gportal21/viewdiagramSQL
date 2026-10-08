import { memo, type ReactNode } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { EntityNode, TableNodeData, TypeNodeData, ViewNodeData } from './build';
import type { Column } from '../schema/model';

/** Handles invisibles a ambos lados de cada fila; la arista elige el lado más corto. */
function SideHandles({ id }: { id: string }) {
  return (
    <>
      <Handle type="source" position={Position.Left} id={`L:s:${id}`} className="h" isConnectable={false} />
      <Handle type="target" position={Position.Left} id={`L:t:${id}`} className="h" isConnectable={false} />
      <Handle type="source" position={Position.Right} id={`R:s:${id}`} className="h" isConnectable={false} />
      <Handle type="target" position={Position.Right} id={`R:t:${id}`} className="h" isConnectable={false} />
    </>
  );
}

export const HEADER_HANDLE = '#';

const KeyIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="5" cy="8" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="M8 8h6.5M12 8v2.6M14.2 8v2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
);
const LinkIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.6 9.4l2.8-2.8M7.3 4.6l1-1a2.6 2.6 0 013.7 3.7l-1 1M8.7 11.4l-1 1A2.6 2.6 0 014 8.7l1-1" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
);
const UniqueIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5l5 5.5-5 5.5L3 8z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /></svg>
);

function columnTitle(c: Column): string {
  return [
    `${c.name} ${c.type}${c.nullable ? '' : ' NOT NULL'}`,
    c.primaryKey && 'PRIMARY KEY',
    c.unique && 'UNIQUE',
    c.identity && `GENERATED ${c.identity} AS IDENTITY`,
    c.generated && `GENERATED ALWAYS AS (${c.generated}) STORED`,
    c.defaultExpr && `DEFAULT ${c.defaultExpr}`,
    c.collation && `COLLATE ${c.collation}`,
    ...c.checks.map((k) => `CHECK (${k})`),
    c.inherited && '(heredada)',
    c.comment && `— ${c.comment}`,
  ]
    .filter(Boolean)
    .join('\n');
}

function Header({ color, schema, name, kindLabel, badges }: { color: string; schema: string; name: string; kindLabel?: string; badges?: ReactNode }) {
  return (
    <div className="node-head" style={{ ['--hc' as string]: color }}>
      <SideHandles id={HEADER_HANDLE} />
      <div className="node-title">
        {kindLabel && <span className="node-kind">{kindLabel}</span>}
        <span className="node-name">
          {schema !== 'public' && <span className="node-schema">{schema}.</span>}
          {name}
        </span>
      </div>
      {badges && <div className="node-badges">{badges}</div>}
    </div>
  );
}

export const TableNode = memo(function TableNode({ data, selected }: NodeProps<EntityNode>) {
  const { table: t, schemaColor, fkCols } = data as TableNodeData;
  const fk = new Set(fkCols);
  const badges: ReactNode[] = [];
  if (t.persistence === 'unlogged') badges.push(<span key="u" className="badge">UNLOGGED</span>);
  if (t.persistence === 'temporary') badges.push(<span key="t" className="badge">TEMP</span>);
  if (t.partitionBy) badges.push(<span key="p" className="badge" title={`PARTITION BY ${t.partitionBy}`}>PARTITIONED</span>);
  if (t.partitionOf) badges.push(<span key="po" className="badge" title={t.partitionBound}>PARTITION</span>);
  if (t.rls) badges.push(<span key="r" className="badge" title="Row Level Security">RLS</span>);
  if (t.triggers.length) badges.push(<span key="tg" className="badge" title={t.triggers.join('\n')}>⚡{t.triggers.length}</span>);

  return (
    <div className={`node node-table${selected ? ' is-selected' : ''}`} title={t.comment}>
      <Header color={schemaColor} schema={t.schema} name={t.name} badges={badges.length ? badges : undefined} />
      <ul className="rows">
        {t.columns.length === 0 && <li className="row row-empty">sin columnas</li>}
        {t.columns.map((c) => (
          <li key={c.name} className={`row${c.inherited ? ' is-inherited' : ''}`} title={columnTitle(c)}>
            <SideHandles id={c.name} />
            <span className="row-icon">
              {c.primaryKey ? (
                <span className="ic ic-pk"><KeyIcon /></span>
              ) : fk.has(c.name) ? (
                <span className="ic ic-fk"><LinkIcon /></span>
              ) : c.unique ? (
                <span className="ic ic-uq"><UniqueIcon /></span>
              ) : null}
            </span>
            <span className={`row-name${c.primaryKey ? ' is-pk' : ''}`}>{c.name}</span>
            <span className={`row-type${c.typeKey ? ' is-usertype' : ''}`}>
              {c.type}
              {c.nullable && !c.primaryKey && <span className="nullable">?</span>}
            </span>
          </li>
        ))}
      </ul>
      {t.indexes.length > 0 && (
        <div className="node-foot">
          <div className="foot-label">Índices</div>
          {t.indexes.map((ix, i) => (
            <div key={ix.name ?? i} className="foot-item" title={[ix.name, ix.method && `USING ${ix.method}`, ix.where && `WHERE ${ix.where}`].filter(Boolean).join('\n')}>
              <span className="ic">{ix.unique ? <UniqueIcon /> : <KeyIcon />}</span>
              <span className="foot-text">
                {ix.columns.join(', ')}
                {ix.method && <em> · {ix.method}</em>}
                {ix.where && <em> · parcial</em>}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
});

const TYPE_LABEL = { enum: 'enum', composite: 'type', domain: 'domain', range: 'range', basetype: 'base type' } as const;

export const TypeNode = memo(function TypeNode({ data, selected }: NodeProps<EntityNode>) {
  const { type: t, schemaColor } = data as TypeNodeData;
  let body: ReactNode;
  switch (t.kind) {
    case 'enum':
      body = t.values.map((v) => (
        <li key={v} className="row row-enum"><span className="row-name">'{v}'</span></li>
      ));
      break;
    case 'composite':
      body = t.fields.map((f) => (
        <li key={f.name} className="row">
          <SideHandles id={f.name} />
          <span className="row-name">{f.name}</span>
          <span className={`row-type${f.typeKey ? ' is-usertype' : ''}`}>{f.type}</span>
        </li>
      ));
      break;
    case 'domain':
      body = (
        <>
          <li className="row"><span className="row-name muted">base</span><span className={`row-type${t.baseTypeKey ? ' is-usertype' : ''}`}>{t.baseType}{t.notNull ? ' NOT NULL' : ''}</span></li>
          {t.defaultExpr && <li className="row"><span className="row-name muted">default</span><span className="row-type">{t.defaultExpr}</span></li>}
          {t.checks.map((c, i) => (
            <li key={i} className="row row-expr" title={c}><span className="row-name muted">check</span><span className="row-type">{c}</span></li>
          ))}
        </>
      );
      break;
    case 'range':
      body = (
        <>
          <li className="row"><span className="row-name muted">subtype</span><span className="row-type">{t.subtype}</span></li>
          {t.options.map((o) => <li key={o} className="row row-expr"><span className="row-type">{o}</span></li>)}
        </>
      );
      break;
    default:
      body = t.options.map((o) => <li key={o} className="row row-expr"><span className="row-type">{o}</span></li>);
  }
  return (
    <div className={`node node-type kind-${t.kind}${selected ? ' is-selected' : ''}`} title={t.comment}>
      <Header color={schemaColor} schema={t.schema} name={t.name} kindLabel={TYPE_LABEL[t.kind]} />
      <ul className="rows">{body}</ul>
    </div>
  );
});

export const ViewNode = memo(function ViewNode({ data, selected }: NodeProps<EntityNode>) {
  const { view: v, schemaColor } = data as ViewNodeData;
  return (
    <div className={`node node-view${selected ? ' is-selected' : ''}`} title={v.comment}>
      <Header color={schemaColor} schema={v.schema} name={v.name} kindLabel={v.materialized ? 'mat. view' : 'view'} />
      <ul className="rows">
        {v.columns.map((c, i) => (
          <li key={`${c}-${i}`} className="row"><span className="row-name">{c}</span></li>
        ))}
      </ul>
    </div>
  );
});

export const nodeTypes = { table: TableNode, type: TypeNode, view: ViewNode };
