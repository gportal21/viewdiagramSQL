import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import { parseSql } from './schema/parse';
import { emptySchema, type Schema } from './schema/model';
import { Diagram, type DiagramHandle } from './diagram/Diagram';
import type { Positions } from './diagram/layout';
import type { Visibility } from './diagram/build';
import { Editor, type EditorHandle } from './panels/Editor';
import { ObjectList } from './panels/ObjectList';
import { Inspector } from './panels/Inspector';
import { defaultVisibility, load, save, type ThemeMode } from './storage';
import sampleSql from './sample.sql?raw';

const saved = load();
const narrow = () => window.matchMedia('(max-width: 820px)').matches;

function usePrefersDark() {
  const [dark, setDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const on = () => setDark(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return dark;
}

const Icon = {
  upload: <path d="M8 11V2.5M4.5 6L8 2.5 11.5 6M2.5 10.5v2a1 1 0 001 1h9a1 1 0 001-1v-2" />,
  layout: <><rect x="2" y="2.5" width="4.5" height="4" rx="1" /><rect x="9.5" y="2.5" width="4.5" height="4" rx="1" /><rect x="5.75" y="9.5" width="4.5" height="4" rx="1" /><path d="M4.25 6.5v1.5h7.5V6.5M8 8v1.5" /></>,
  fit: <path d="M2.5 6V3.5a1 1 0 011-1H6M10 2.5h2.5a1 1 0 011 1V6M13.5 10v2.5a1 1 0 01-1 1H10M6 13.5H3.5a1 1 0 01-1-1V10" />,
  download: <path d="M8 2.5V11M4.5 7.5L8 11l3.5-3.5M2.5 13.5h11" />,
  sun: <><circle cx="8" cy="8" r="3" /><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1" /></>,
  moon: <path d="M13 9.5A5.5 5.5 0 016.5 3a5.5 5.5 0 106.5 6.5z" />,
  auto: <><circle cx="8" cy="8" r="5.5" /><path d="M8 2.5v11A5.5 5.5 0 008 2.5z" fill="currentColor" /></>,
  panel: <><rect x="2" y="2.5" width="12" height="11" rx="1.5" /><path d="M6 2.5v11" /></>,
};
const I = ({ d }: { d: React.ReactNode }) => (
  <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">{d}</svg>
);

export function App() {
  const [sql, setSql] = useState<string>(saved.sql ?? sampleSql);
  const [fileName, setFileName] = useState<string>(saved.fileName ?? 'ejemplo.sql');
  const [schema, setSchema] = useState<Schema>(emptySchema);
  const [parsing, setParsing] = useState(true);
  const [positions, setPositions] = useState<Positions>(saved.positions ?? {});
  const [visibility, setVisibility] = useState<Visibility>({ ...defaultVisibility, ...saved.visibility });
  const [theme, setTheme] = useState<ThemeMode>(saved.theme ?? 'system');
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(saved.sidebarOpen ?? !narrow());
  const [tab, setTab] = useState<'sql' | 'objects'>('sql');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const diagram = useRef<DiagramHandle>(null);
  const editor = useRef<EditorHandle>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const prefersDark = usePrefersDark();
  const dark = theme === 'dark' || (theme === 'system' && prefersDark);

  // Tema: sin atributo = sigue al sistema.
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') delete root.dataset.theme;
    else root.dataset.theme = theme;
  }, [theme]);

  // Parseo con debounce; descartamos resultados viejos.
  const parseSeq = useRef(0);
  useEffect(() => {
    const seq = ++parseSeq.current;
    setParsing(true);
    const t = window.setTimeout(async () => {
      try {
        const s = await parseSql(sql);
        if (seq === parseSeq.current) setSchema(s);
      } catch (e) {
        if (seq === parseSeq.current) {
          const s = emptySchema();
          s.issues.push({ severity: 'error', message: `No se pudo cargar el parser: ${(e as Error).message}`, line: 1, column: 1 });
          setSchema(s);
        }
      } finally {
        if (seq === parseSeq.current) setParsing(false);
      }
    }, 350);
    return () => window.clearTimeout(t);
  }, [sql]);

  useEffect(() => {
    save({ sql, fileName, positions, visibility, theme, sidebarOpen });
  }, [sql, fileName, positions, visibility, theme, sidebarOpen]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(t);
  }, [toast]);

  // Si el objeto seleccionado desaparece tras editar, cerramos el detalle.
  useEffect(() => {
    if (!selectedId) return;
    const k = selectedId.slice(2);
    const exists = schema.tables.has(k) || schema.views.has(k) || schema.types.has(k);
    if (!exists && !parsing) setSelectedId(null);
  }, [schema, selectedId, parsing]);

  const loadText = useCallback((text: string, name: string) => {
    setPositions({});
    setSelectedId(null);
    setSql(text);
    setFileName(name);
    setTab('sql');
    setToast(`Importado ${name}`);
  }, []);

  const readFile = useCallback(
    (file: File) => {
      file.text().then((t) => loadText(t, file.name), () => setToast(`No se pudo leer ${file.name}`));
    },
    [loadText],
  );

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) readFile(f);
    e.target.value = '';
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files?.[0];
    if (f) readFile(f);
  };

  const goToLine = useCallback(
    (line: number, column?: number) => {
      setSidebarOpen(true);
      setTab('sql');
      requestAnimationFrame(() => editor.current?.goToLine(line, column));
    },
    [],
  );

  const pick = useCallback((id: string) => {
    setSelectedId(id);
    diagram.current?.focus(id);
  }, []);

  const stats = useMemo(() => {
    const fks = [...schema.tables.values()].reduce((n, t) => n + t.foreignKeys.filter((f) => !f.unresolved).length, 0);
    return { tables: schema.tables.size, types: schema.types.size, views: schema.views.size, fks };
  }, [schema]);

  const errors = schema.issues.filter((i) => i.severity === 'error');
  const warnings = schema.issues.filter((i) => i.severity === 'warning');
  const baseName = fileName.replace(/\.[^.]+$/, '') || 'diagrama';
  const nextTheme: Record<ThemeMode, ThemeMode> = { system: 'light', light: 'dark', dark: 'system' };
  const themeLabel: Record<ThemeMode, string> = { system: 'Tema: sistema', light: 'Tema: claro', dark: 'Tema: oscuro' };

  return (
    <div
      className="app"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target || !e.relatedTarget) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <header className="topbar">
        <button type="button" className="btn btn-ghost btn-icon" onClick={() => setSidebarOpen((o) => !o)} aria-label={sidebarOpen ? 'Ocultar panel' : 'Mostrar panel'} aria-expanded={sidebarOpen}>
          <I d={Icon.panel} />
        </button>
        <div className="brand">
          <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="7" fill="var(--accent)" /><rect x="5" y="7" width="10" height="13" rx="2" fill="var(--on-accent)" /><rect x="18" y="13" width="9" height="12" rx="2" fill="var(--on-accent)" /><path d="M15 16h3" stroke="var(--on-accent)" strokeWidth="2" /></svg>
          <span className="brand-name">viewdiagram<b>SQL</b></span>
          <span className="file-name" title={fileName}>{fileName}</span>
        </div>
        <div className="stats" aria-live="polite">
          {parsing ? (
            <span className="stat muted">Analizando…</span>
          ) : (
            <>
              <span className="stat"><b>{stats.tables}</b> {stats.tables === 1 ? 'tabla' : 'tablas'}</span>
              <span className="stat"><b>{stats.fks}</b> {stats.fks === 1 ? 'relación' : 'relaciones'}</span>
              {stats.types > 0 && <span className="stat"><b>{stats.types}</b> {stats.types === 1 ? 'tipo' : 'tipos'}</span>}
              {stats.views > 0 && <span className="stat"><b>{stats.views}</b> {stats.views === 1 ? 'vista' : 'vistas'}</span>}
              {errors.length > 0 && (
                <button type="button" className="stat stat-error" onClick={() => goToLine(errors[0].line, errors[0].column)}>
                  {errors.length} {errors.length === 1 ? 'error' : 'errores'}
                </button>
              )}
            </>
          )}
        </div>
        <div className="actions">
          <input ref={fileInput} id="file-input" type="file" accept=".sql,.psql,.pgsql,.txt,text/plain,application/sql" hidden onChange={onFile} />
          <button type="button" className="btn btn-primary" onClick={() => fileInput.current?.click()}>
            <I d={Icon.upload} /> <span className="btn-text">Importar .sql</span>
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => diagram.current?.relayout()} title="Reordenar automáticamente">
            <I d={Icon.layout} /> <span className="btn-text">Reordenar</span>
          </button>
          <button type="button" className="btn btn-ghost btn-icon" onClick={() => diagram.current?.fit()} aria-label="Ajustar a la pantalla" title="Ajustar a la pantalla">
            <I d={Icon.fit} />
          </button>
          <div className="menu-wrap">
            <button type="button" className="btn btn-ghost" onClick={() => setExportOpen((o) => !o)} aria-expanded={exportOpen} aria-haspopup="menu">
              <I d={Icon.download} /> <span className="btn-text">Exportar</span>
            </button>
            {exportOpen && (
              <div className="menu" role="menu" onMouseLeave={() => setExportOpen(false)}>
                <button type="button" role="menuitem" onClick={() => { setExportOpen(false); diagram.current?.exportImage('png', baseName); }}>Imagen PNG</button>
                <button type="button" role="menuitem" onClick={() => { setExportOpen(false); diagram.current?.exportImage('svg', baseName); }}>Imagen SVG</button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setExportOpen(false);
                    const url = URL.createObjectURL(new Blob([sql], { type: 'application/sql' }));
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = fileName.endsWith('.sql') ? fileName : `${baseName}.sql`;
                    a.click();
                    URL.revokeObjectURL(url);
                  }}
                >
                  Archivo .sql
                </button>
              </div>
            )}
          </div>
          <button type="button" className="btn btn-ghost btn-icon" onClick={() => setTheme(nextTheme[theme])} aria-label={themeLabel[theme]} title={themeLabel[theme]}>
            <I d={theme === 'system' ? Icon.auto : theme === 'light' ? Icon.sun : Icon.moon} />
          </button>
        </div>
      </header>

      <main className={`workspace${sidebarOpen ? '' : ' sidebar-closed'}`}>
        <aside className="sidebar" aria-hidden={!sidebarOpen}>
          <div className="tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === 'sql'} className={`tab${tab === 'sql' ? ' is-active' : ''}`} onClick={() => setTab('sql')}>
              SQL
              {errors.length > 0 && <span className="tab-badge is-error">{errors.length}</span>}
            </button>
            <button type="button" role="tab" aria-selected={tab === 'objects'} className={`tab${tab === 'objects' ? ' is-active' : ''}`} onClick={() => setTab('objects')}>
              Objetos <span className="tab-badge">{stats.tables + stats.types + stats.views}</span>
            </button>
            <div className="tabs-spacer" />
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => loadText(sampleSql, 'ejemplo.sql')}>Ejemplo</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setSql(''); setFileName('sin título.sql'); setPositions({}); setSelectedId(null); }}>Limpiar</button>
          </div>

          <div className="tab-panel" hidden={tab !== 'sql'}>
            <div className="editor-wrap">
              <Editor ref={editor} value={sql} onChange={setSql} issues={schema.issues} dark={dark} />
            </div>
            {schema.issues.length > 0 && (
              <div className="issues">
                <div className="issues-head">
                  {errors.length > 0 && <span className="pill pill-error">{errors.length} {errors.length === 1 ? 'error' : 'errores'}</span>}
                  {warnings.length > 0 && <span className="pill pill-warn">{warnings.length} {warnings.length === 1 ? 'aviso' : 'avisos'}</span>}
                  {errors.length > 0 && <span className="muted">Lo válido se sigue dibujando.</span>}
                </div>
                <ul>
                  {schema.issues.slice(0, 200).map((i, n) => (
                    <li key={n}>
                      <button type="button" className={`issue issue-${i.severity}`} onClick={() => goToLine(i.line, i.column)}>
                        <span className="issue-loc">{i.line}:{i.column}</span>
                        <span className="issue-msg">{i.message}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="editor-foot">
              <span>{schema.pgVersion ? `Parser PostgreSQL ${Math.floor(schema.pgVersion / 10000)}` : 'Parser PostgreSQL'}</span>
              <span>{schema.statementCount} sentencias</span>
              <span className="muted">Arrastra un .sql aquí para importarlo</span>
            </div>
          </div>

          <div className="tab-panel" hidden={tab !== 'objects'}>
            <ObjectList schema={schema} visibility={visibility} onVisibility={setVisibility} selectedId={selectedId} onPick={(id) => pick(id)} onLine={goToLine} />
          </div>
        </aside>

        <section className="canvas" aria-label="Diagrama">
          <Diagram ref={diagram} schema={schema} visibility={visibility} positions={positions} onPositionsChange={setPositions} selectedId={selectedId} onSelect={setSelectedId} />
          {!parsing && stats.tables + stats.types + stats.views === 0 && (
            <div className="empty-state">
              <h2>Pega tu SQL o importa un archivo</h2>
              <p>Acepta cualquier script válido de PostgreSQL: tablas, claves foráneas, enums, tipos compuestos, dominios, rangos, vistas, particiones y dumps de <code>pg_dump</code>.</p>
              <div className="empty-actions">
                <button type="button" className="btn btn-primary" onClick={() => fileInput.current?.click()}><I d={Icon.upload} /> Importar .sql</button>
                <button type="button" className="btn btn-ghost" onClick={() => loadText(sampleSql, 'ejemplo.sql')}>Cargar ejemplo</button>
              </div>
            </div>
          )}
          {selectedId && <Inspector schema={schema} selectedId={selectedId} onClose={() => setSelectedId(null)} onLine={goToLine} onPick={pick} />}
          <div className="legend" aria-hidden="true">
            <span><svg viewBox="0 0 40 12"><path d="M2 6h36M30 1v10M34 1v10" /></svg>uno</span>
            <span><svg viewBox="0 0 40 12"><path d="M2 6h36M26 6l12-5M26 6l12 5M24 1v10" /></svg>muchos</span>
            <span><svg viewBox="0 0 40 12"><path d="M2 6h36" strokeDasharray="4 3" /></svg>tipo</span>
          </div>
        </section>
      </main>

      {dragging && (
        <div className="drop-overlay">
          <div>Suelta el archivo .sql para importarlo</div>
        </div>
      )}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
