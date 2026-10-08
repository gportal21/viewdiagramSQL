import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseSql } from './parse';
import { splitStatements, preprocess } from './split';

const sample = readFileSync(new URL('../sample.sql', import.meta.url), 'utf8');

describe('parseSql', () => {
  it('parsea el ejemplo completo', async () => {
    const s = await parseSql(sample);
    expect(s.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect([...s.tables.keys()].sort()).toEqual(
      ['auth.refresh_token', 'auth.session', 'auth.user', 'public.ad', 'public.company'].sort(),
    );
    expect(s.types.get('public.ad_status')).toMatchObject({ kind: 'enum', values: ['draft', 'pending_review', 'active', 'paused', 'rejected'] });
    expect(s.types.get('public.email')).toMatchObject({ kind: 'domain', baseType: 'citext' });
    expect(s.types.get('public.dimensions')).toMatchObject({ kind: 'composite' });

    const ad = s.tables.get('public.ad')!;
    expect(sample.split('\n')[ad.line - 1]).toMatch(/^CREATE TABLE ad \(/);
    expect(ad.comment).toMatch(/Anuncios/);
    expect(ad.columns.find((c) => c.name === 'status')).toMatchObject({ typeKey: 'public.ad_status', nullable: false, defaultExpr: "'draft'" });
    expect(ad.columns.find((c) => c.name === 'tags')).toMatchObject({ type: 'text[]', isArray: true });
    expect(ad.foreignKeys.map((f) => f.refTable).sort()).toEqual(['auth.user', 'public.company']);
    expect(ad.indexes).toHaveLength(2);

    const rt = s.tables.get('auth.refresh_token')!;
    expect(rt.foreignKeys[0]).toMatchObject({ refTable: 'auth.session', refColumns: ['id'], onDelete: 'CASCADE', columns: ['session_id'] });

    const user = s.tables.get('auth.user')!;
    expect(user.columns.find((c) => c.name === 'email')).toMatchObject({ typeKey: 'public.email', unique: true });

    const mv = s.views.get('public.company_ad_stats')!;
    expect(mv.materialized).toBe(true);
    expect(mv.columns).toEqual(['company_id', 'trade_name', 'active_ads', 'total_bytes']);
    expect(mv.dependsOn.sort()).toEqual(['public.ad', 'public.company']);
  });

  it('herencia, particiones, OF type, ALTER, RENAME y search_path', async () => {
    const s = await parseSql(`
      SET search_path = app, public;
      CREATE TYPE addr AS (street text, num int);
      CREATE TABLE base (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, created timestamptz);
      CREATE TABLE child (extra text) INHERITS (base);
      CREATE TABLE events (id bigint, at date NOT NULL, PRIMARY KEY (id, at)) PARTITION BY RANGE (at);
      CREATE TABLE events_2026 PARTITION OF events FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
      CREATE TABLE places OF addr (PRIMARY KEY (street));
      CREATE TABLE old_name (a int, b int);
      ALTER TABLE old_name RENAME TO new_name;
      ALTER TABLE new_name RENAME COLUMN a TO aa;
      ALTER TABLE new_name ADD COLUMN c text NOT NULL DEFAULT 'x', DROP COLUMN b;
      ALTER TYPE addr RENAME TO address;
      CREATE TYPE mood AS ENUM ('sad', 'ok');
      ALTER TYPE mood ADD VALUE 'happy' AFTER 'ok';
      ALTER TYPE mood ADD VALUE 'meh' BEFORE 'ok';
      CREATE TABLE fk_comp (x bigint, y date, FOREIGN KEY (x, y) REFERENCES events MATCH FULL ON UPDATE CASCADE);
    `);
    expect(s.issues.filter((i) => i.severity === 'error')).toEqual([]);
    const child = s.tables.get('app.child')!;
    expect(child.inherits).toEqual(['app.base']);
    expect(child.columns.map((c) => c.name)).toEqual(['id', 'created', 'extra']);
    expect(child.columns[0].inherited).toBe(true);
    const part = s.tables.get('app.events_2026')!;
    expect(part.partitionOf).toBe('app.events');
    expect(part.partitionBound).toMatch(/FROM \('2026-01-01'\) TO/);
    expect(s.tables.get('app.events')!.partitionBy).toBe('RANGE (at)');
    expect(s.tables.get('app.places')!.columns.map((c) => c.name)).toEqual(['street', 'num']);
    expect(s.tables.get('app.places')!.primaryKey).toEqual(['street']);
    const nn = s.tables.get('app.new_name')!;
    expect(nn.columns.map((c) => c.name)).toEqual(['aa', 'c']);
    expect(s.types.has('app.address')).toBe(true);
    expect((s.types.get('app.mood') as { values: string[] }).values).toEqual(['sad', 'meh', 'ok', 'happy']);
    const fk = s.tables.get('app.fk_comp')!.foreignKeys[0];
    expect(fk).toMatchObject({ refTable: 'app.events', refColumns: ['id', 'at'], match: 'FULL', onUpdate: 'CASCADE' });
  });

  it('se recupera de errores de sintaxis e indica la línea', async () => {
    const s = await parseSql(`CREATE TABLE ok1 (id int);\n\nCREATE TABLE bad (id int,, x text);\nCREATE TABLE ok2 (id int REFERENCES ok1);`);
    expect([...s.tables.keys()].sort()).toEqual(['public.ok1', 'public.ok2']);
    const err = s.issues.find((i) => i.severity === 'error')!;
    expect(err.line).toBe(3);
    expect(err.column).toBe(26);
    expect(s.tables.get('public.ok2')!.foreignKeys[0].refColumns).toEqual([]);
    expect(s.tables.get('public.ok2')!.line).toBe(4);
    expect(s.tables.get('public.ok1')!.line).toBe(1);
  });

  it('entiende un dump de pg_dump con COPY y meta-comandos', async () => {
    const s = await parseSql(`--
-- PostgreSQL database dump
--
\\restrict abc123
SET statement_timeout = 0;
SELECT pg_catalog.set_config('search_path', '', false);
CREATE TABLE public.t (id integer NOT NULL, name text);
ALTER TABLE public.t OWNER TO postgres;
CREATE SEQUENCE public.t_id_seq AS integer START WITH 1;
ALTER TABLE ONLY public.t ALTER COLUMN id SET DEFAULT nextval('public.t_id_seq'::regclass);
COPY public.t (id, name) FROM stdin;
1	hola; mundo
2	'raro
\\.
ALTER TABLE ONLY public.t ADD CONSTRAINT t_pkey PRIMARY KEY (id);
\\unrestrict abc123
`);
    expect(s.issues).toEqual([]);
    const t = s.tables.get('public.t')!;
    expect(t.primaryKey).toEqual(['id']);
    expect(t.columns[0].defaultExpr).toBe("nextval('public.t_id_seq'::regclass)");
  });

  it('acepta sintaxis poco común de Postgres', async () => {
    const s = await parseSql(`
      CREATE TYPE floatrange AS RANGE (subtype = float8, subtype_diff = float8mi);
      CREATE UNLOGGED TABLE "Weird Name" ("Col A" int[][], b bit varying(5), c interval day to second(3),
        d tsrange, g int GENERATED ALWAYS AS ("Col A"[1][1] * 2) STORED,
        EXCLUDE USING gist (d WITH &&));
      CREATE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RETURN NEW; END; $fn$;
      CREATE TRIGGER trg BEFORE INSERT ON "Weird Name" FOR EACH ROW EXECUTE FUNCTION f();
      ALTER TABLE "Weird Name" ENABLE ROW LEVEL SECURITY;
      CREATE VIEW v (x, y) AS WITH q AS (SELECT 1) SELECT 1, 2 FROM "Weird Name", q;
    `);
    expect(s.issues).toEqual([]);
    const t = s.tables.get('public.Weird Name')!;
    expect(t.persistence).toBe('unlogged');
    expect(t.rls).toBe(true);
    expect(t.triggers).toHaveLength(1);
    expect(t.constraints[0].kind).toBe('EXCLUDE');
    expect(t.columns.find((c) => c.name === 'g')!.generated).toContain('* 2');
    expect(s.types.get('public.floatrange')).toMatchObject({ kind: 'range', subtype: 'float8' });
    expect(s.views.get('public.v')).toMatchObject({ columns: ['x', 'y'], dependsOn: ['public.Weird Name'] });
  });
});

describe('splitStatements', () => {
  it('respeta comillas, dollar quoting y comentarios', () => {
    const parts = splitStatements(`select ';'; /* ; */ select $$;$$; select E'\\';'; -- ;\nselect "a;b";`);
    expect(parts.map((p) => p.text.trim())).toEqual([`select ';';`, `/* ; */ select $$;$$;`, `select E'\\';';`, `-- ;\nselect "a;b";`]);
  });
  it('preprocess conserva las líneas', () => {
    const src = 'a;\n\\connect x\nCOPY t FROM stdin;\n1\n\\.\nb;';
    expect(preprocess(src).split('\n')).toHaveLength(src.split('\n').length);
  });
});
