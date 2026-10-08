import type { ReactNode } from 'react';
import type { Schema, Table } from '../schema/model';
import { nodeId } from '../diagram/build';

interface Props {
  schema: Schema;
  selectedId: string;
  onClose: () => void;
  onLine: (line: number) => void;
  onPick: (nodeId: string) => void;
}

const short = (k: string) => k.replace(/^public\./, '');

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="insp-section">
      <h4>{title}</h4>
      {children}
    </section>
  );
}

function Code({ children }: { children: ReactNode }) {
  return <code className="insp-code">{children}</code>;
}

function TableDetail({ t, schema, onPick }: { t: Table; schema: Schema; onPick: (id: string) => void }) {
  const incoming = [...schema.tables.values()].flatMap((o) => o.foreignKeys.filter((f) => f.refTable === t.key).map((f) => ({ from: o, fk: f })));
  return (
    <>
      {t.comment && <p className="insp-comment">{t.comment}</p>}
      <Section title={`Columnas (${t.columns.length})`}>
        <table className="insp-table">
          <tbody>
            {t.columns.map((c) => (
              <tr key={c.name} className={c.inherited ? 'is-inherited' : ''}>
                <th scope="row">
                  {c.name}
                  {c.primaryKey && <span className="tag tag-pk">PK</span>}
                  {t.foreignKeys.some((f) => f.columns.includes(c.name)) && <span className="tag tag-fk">FK</span>}
                  {c.unique && !c.primaryKey && <span className="tag">UQ</span>}
                </th>
                <td>
                  <Code>{c.type}</Code>
                  {!c.nullable && <span className="muted"> not null</span>}
                  {c.identity && <div className="sub">identity {c.identity.toLowerCase()}</div>}
                  {c.generated && <div className="sub">generated <Code>{c.generated}</Code></div>}
                  {c.defaultExpr && <div className="sub">default <Code>{c.defaultExpr}</Code></div>}
                  {c.collation && <div className="sub">collate {c.collation}</div>}
                  {c.checks.map((k, i) => <div key={i} className="sub">check <Code>{k}</Code></div>)}
                  {c.comment && <div className="sub comment">{c.comment}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
      {t.foreignKeys.length > 0 && (
        <Section title="Referencia a">
          <ul className="insp-list">
            {t.foreignKeys.map((f, i) => (
              <li key={i}>
                <Code>({f.columns.join(', ')})</Code> →{' '}
                {f.unresolved ? <span className="warn">{short(f.refTable)} (no definida)</span> : <button type="button" className="link" onClick={() => onPick(nodeId.table(f.refTable))}>{short(f.refTable)}</button>}
                <Code>({f.refColumns.join(', ')})</Code>
                <div className="sub">
                  {[f.name, f.onDelete !== 'NO ACTION' && `on delete ${f.onDelete.toLowerCase()}`, f.onUpdate !== 'NO ACTION' && `on update ${f.onUpdate.toLowerCase()}`, f.match && f.match !== 'SIMPLE' && `match ${f.match.toLowerCase()}`, f.deferrable && 'deferrable']
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {incoming.length > 0 && (
        <Section title="Referenciada por">
          <ul className="insp-list">
            {incoming.map(({ from, fk }, i) => (
              <li key={i}>
                <button type="button" className="link" onClick={() => onPick(nodeId.table(from.key))}>{short(from.key)}</button> <Code>({fk.columns.join(', ')})</Code>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {t.constraints.filter((k) => k.kind !== 'PRIMARY KEY').length > 0 && (
        <Section title="Restricciones">
          <ul className="insp-list">
            {t.constraints.filter((k) => k.kind !== 'PRIMARY KEY').map((k, i) => (
              <li key={i}>
                <strong>{k.kind}</strong> {k.columns.length > 0 && <Code>({k.columns.join(', ')})</Code>} {k.expr && <Code>{k.expr}</Code>}
                {k.name && <div className="sub">{k.name}</div>}
              </li>
            ))}
          </ul>
        </Section>
      )}
      {t.indexes.length > 0 && (
        <Section title="Índices">
          <ul className="insp-list">
            {t.indexes.map((ix, i) => (
              <li key={i}>
                {ix.unique && <strong>UNIQUE </strong>}
                <Code>({ix.columns.join(', ')})</Code>
                <div className="sub">
                  {[ix.name, ix.method && `using ${ix.method}`, ix.include?.length && `include (${ix.include.join(', ')})`].filter(Boolean).join(' · ')}
                </div>
                {ix.where && <div className="sub">where <Code>{ix.where}</Code></div>}
              </li>
            ))}
          </ul>
        </Section>
      )}
      {(t.partitionBy || t.partitionOf || t.inherits.length > 0 || t.ofType) && (
        <Section title="Estructura">
          <ul className="insp-list">
            {t.partitionBy && <li>Particionada por <Code>{t.partitionBy}</Code></li>}
            {t.partitionOf && <li>Partición de <button type="button" className="link" onClick={() => onPick(nodeId.table(t.partitionOf!))}>{short(t.partitionOf)}</button> <Code>{t.partitionBound}</Code></li>}
            {t.inherits.map((p) => <li key={p}>Hereda de <button type="button" className="link" onClick={() => onPick(nodeId.table(p))}>{short(p)}</button></li>)}
            {t.ofType && <li>Tabla tipada <Code>OF {short(t.ofType)}</Code></li>}
          </ul>
        </Section>
      )}
      {(t.triggers.length > 0 || t.policies.length > 0 || t.rls) && (
        <Section title="Triggers y seguridad">
          <ul className="insp-list">
            {t.rls && <li>Row Level Security activado</li>}
            {t.triggers.map((x) => <li key={x}>Trigger <Code>{x}</Code></li>)}
            {t.policies.map((x) => <li key={x}>Política <Code>{x}</Code></li>)}
          </ul>
        </Section>
      )}
    </>
  );
}

export function Inspector({ schema, selectedId, onClose, onLine, onPick }: Props) {
  const [prefix, key] = [selectedId.slice(0, 1), selectedId.slice(2)];
  const table = prefix === 't' ? schema.tables.get(key) : undefined;
  const view = prefix === 'v' ? schema.views.get(key) : undefined;
  const type = prefix === 'y' ? schema.types.get(key) : undefined;
  const entity = table ?? view ?? type;
  if (!entity) return null;

  const kindLabel = table ? 'Tabla' : view ? (view.materialized ? 'Vista materializada' : 'Vista') : ({ enum: 'Enum', composite: 'Tipo compuesto', domain: 'Dominio', range: 'Tipo rango', basetype: 'Tipo base' } as const)[type!.kind];

  const usedBy = type
    ? [...schema.tables.values()].flatMap((t) => t.columns.filter((c) => c.typeKey === type.key).map((c) => ({ t, c })))
    : [];

  return (
    <aside className="inspector" aria-label="Detalle del objeto">
      <header className="insp-head">
        <div>
          <div className="insp-kind">{kindLabel}</div>
          <h2>
            {entity.schema !== 'public' && <span className="muted">{entity.schema}.</span>}
            {entity.name}
          </h2>
        </div>
        <div className="insp-actions">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onLine(entity.line)} title="Mostrar en el editor">Línea {entity.line}</button>
          <button type="button" className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Cerrar detalle">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
          </button>
        </div>
      </header>
      <div className="insp-body">
        {table && <TableDetail t={table} schema={schema} onPick={onPick} />}
        {view && (
          <>
            {view.comment && <p className="insp-comment">{view.comment}</p>}
            <Section title={`Columnas (${view.columns.length})`}>
              <ul className="insp-list">{view.columns.map((c, i) => <li key={i}><Code>{c}</Code></li>)}</ul>
            </Section>
            {view.dependsOn.length > 0 && (
              <Section title="Depende de">
                <ul className="insp-list">
                  {view.dependsOn.map((d) => (
                    <li key={d}><button type="button" className="link" onClick={() => onPick(schema.tables.has(d) ? nodeId.table(d) : nodeId.view(d))}>{short(d)}</button></li>
                  ))}
                </ul>
              </Section>
            )}
            <Section title="Definición">
              <pre className="insp-pre">{view.definition}</pre>
            </Section>
          </>
        )}
        {type && (
          <>
            {type.comment && <p className="insp-comment">{type.comment}</p>}
            {type.kind === 'enum' && (
              <Section title={`Valores (${type.values.length})`}>
                <ol className="insp-list insp-ol">{type.values.map((v) => <li key={v}><Code>'{v}'</Code></li>)}</ol>
              </Section>
            )}
            {type.kind === 'composite' && (
              <Section title="Campos">
                <ul className="insp-list">{type.fields.map((f) => <li key={f.name}>{f.name} <Code>{f.type}</Code></li>)}</ul>
              </Section>
            )}
            {type.kind === 'domain' && (
              <Section title="Definición">
                <ul className="insp-list">
                  <li>Tipo base <Code>{type.baseType}</Code>{type.notNull && ' not null'}</li>
                  {type.defaultExpr && <li>Default <Code>{type.defaultExpr}</Code></li>}
                  {type.checks.map((c, i) => <li key={i}>Check <Code>{c}</Code></li>)}
                </ul>
              </Section>
            )}
            {(type.kind === 'range' || type.kind === 'basetype') && (
              <Section title="Opciones">
                <ul className="insp-list">
                  {type.kind === 'range' && <li>subtype <Code>{type.subtype}</Code></li>}
                  {type.options.map((o) => <li key={o}><Code>{o}</Code></li>)}
                </ul>
              </Section>
            )}
            <Section title={`Usado en (${usedBy.length})`}>
              {usedBy.length ? (
                <ul className="insp-list">
                  {usedBy.map(({ t, c }) => (
                    <li key={t.key + c.name}><button type="button" className="link" onClick={() => onPick(nodeId.table(t.key))}>{short(t.key)}</button>.{c.name}</li>
                  ))}
                </ul>
              ) : (
                <p className="muted">Ninguna columna usa este tipo.</p>
              )}
            </Section>
          </>
        )}
      </div>
    </aside>
  );
}
