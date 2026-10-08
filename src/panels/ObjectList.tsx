import { useMemo, useState } from 'react';
import type { MiscObject, Schema } from '../schema/model';
import { nodeId, schemaColor, type Visibility } from '../diagram/build';

interface Props {
  schema: Schema;
  visibility: Visibility;
  onVisibility: (v: Visibility) => void;
  selectedId: string | null;
  onPick: (nodeId: string, line: number) => void;
  onLine: (line: number) => void;
}

interface Item {
  id: string;
  label: string;
  schema: string;
  meta: string;
  line: number;
}

const MISC_LABEL: Record<MiscObject['kind'], string> = {
  schema: 'Esquemas',
  extension: 'Extensiones',
  sequence: 'Secuencias',
  function: 'Funciones',
  procedure: 'Procedimientos',
  trigger: 'Triggers',
  policy: 'Políticas RLS',
  other: 'Otros',
};

export function ObjectList({ schema, visibility, onVisibility, selectedId, onPick, onLine }: Props) {
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const match = (s: string) => !needle || s.toLowerCase().includes(needle);

  const groups = useMemo(() => {
    const g: { title: string; items: Item[] }[] = [];
    const tables = [...schema.tables.values()].map<Item>((t) => ({
      id: nodeId.table(t.key),
      label: t.name,
      schema: t.schema,
      meta: `${t.columns.length} col${t.foreignKeys.length ? ` · ${t.foreignKeys.length} FK` : ''}`,
      line: t.line,
    }));
    g.push({ title: 'Tablas', items: tables });
    g.push({
      title: 'Vistas',
      items: [...schema.views.values()].map((v) => ({ id: nodeId.view(v.key), label: v.name, schema: v.schema, meta: v.materialized ? 'materializada' : 'vista', line: v.line })),
    });
    const byKind = (k: string, title: string, meta: (t: never) => string) =>
      g.push({
        title,
        items: [...schema.types.values()].filter((t) => t.kind === k).map((t) => ({ id: nodeId.type(t.key), label: t.name, schema: t.schema, meta: meta(t as never), line: t.line })),
      });
    byKind('enum', 'Enums', (t: { values: string[] }) => `${t.values.length} valores`);
    byKind('composite', 'Tipos compuestos', (t: { fields: unknown[] }) => `${t.fields.length} campos`);
    byKind('domain', 'Dominios', (t: { baseType: string }) => t.baseType);
    byKind('range', 'Rangos', (t: { subtype: string }) => t.subtype);
    byKind('basetype', 'Tipos base', () => 'base');
    return g.filter((x) => x.items.length);
  }, [schema]);

  const misc = useMemo(() => {
    const m = new Map<MiscObject['kind'], MiscObject[]>();
    for (const o of schema.misc) m.set(o.kind, [...(m.get(o.kind) ?? []), o]);
    return [...m.entries()].filter(([k]) => k !== 'schema');
  }, [schema]);

  const toggleSchema = (s: string) => {
    const hidden = new Set(visibility.hiddenSchemas);
    if (hidden.has(s)) hidden.delete(s);
    else hidden.add(s);
    onVisibility({ ...visibility, hiddenSchemas: [...hidden] });
  };

  return (
    <div className="objects">
      <div className="objects-tools">
        <input id="object-search" className="search" type="search" placeholder="Buscar tabla, tipo, vista…" value={q} onChange={(e) => setQ(e.target.value)} />
        {schema.schemas.length > 1 && (
          <div className="chips" role="group" aria-label="Esquemas visibles">
            {schema.schemas.map((s) => {
              const off = visibility.hiddenSchemas.includes(s);
              return (
                <button key={s} type="button" className={`chip${off ? ' is-off' : ''}`} aria-pressed={!off} onClick={() => toggleSchema(s)} style={{ ['--hc' as string]: schemaColor(schema.schemas, s) }}>
                  <span className="chip-dot" />
                  {s}
                </button>
              );
            })}
          </div>
        )}
        <div className="toggles">
          <label><input id="show-types" type="checkbox" checked={visibility.showTypes} onChange={(e) => onVisibility({ ...visibility, showTypes: e.target.checked })} /> Tipos en el diagrama</label>
          <label><input id="show-type-edges" type="checkbox" checked={visibility.showTypeEdges} disabled={!visibility.showTypes} onChange={(e) => onVisibility({ ...visibility, showTypeEdges: e.target.checked })} /> Conectar columnas con sus tipos</label>
          <label><input id="show-views" type="checkbox" checked={visibility.showViews} onChange={(e) => onVisibility({ ...visibility, showViews: e.target.checked })} /> Vistas</label>
        </div>
      </div>

      <div className="objects-scroll">
        {groups.map((g) => {
          const items = g.items.filter((i) => match(i.label) || match(i.schema + '.' + i.label));
          if (!items.length) return null;
          return (
            <section key={g.title} className="group">
              <h3>{g.title} <span className="count">{items.length}</span></h3>
              <ul>
                {items.map((i) => (
                  <li key={i.id}>
                    <button type="button" className={`obj${selectedId === i.id ? ' is-active' : ''}`} onClick={() => onPick(i.id, i.line)}>
                      <span className="obj-dot" style={{ background: schemaColor(schema.schemas, i.schema) }} />
                      <span className="obj-name">
                        {i.schema !== 'public' && <span className="obj-schema">{i.schema}.</span>}
                        {i.label}
                      </span>
                      <span className="obj-meta">{i.meta}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
        {misc.map(([kind, list]) => {
          const items = list.filter((o) => match(o.name));
          if (!items.length) return null;
          return (
            <section key={kind} className="group group-misc">
              <h3>{MISC_LABEL[kind]} <span className="count">{items.length}</span></h3>
              <ul>
                {items.map((o, i) => (
                  <li key={`${o.name}-${i}`}>
                    <button type="button" className="obj obj-misc" onClick={() => onLine(o.line)} title={`Ir a la línea ${o.line}`}>
                      <span className="obj-name">{o.name}</span>
                      {o.detail && <span className="obj-meta">{o.detail}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
        {!groups.length && !misc.length && <p className="empty">Todavía no hay objetos. Pega SQL en la pestaña SQL o importa un archivo.</p>}
      </div>
    </div>
  );
}
