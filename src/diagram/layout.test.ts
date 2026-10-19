import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseSql } from '../schema/parse';
import { buildGraph, estimateSize, shortBound } from './build';
import { autoLayout } from './layout';

const sample = readFileSync(new URL('../sample.sql', import.meta.url), 'utf8');
const vis = { hiddenSchemas: [], showTypes: true, showEnums: true, showPartitions: false, showViews: true, showTypeEdges: true };

describe('autoLayout', () => {
  it('coloca los tipos junto a sus tablas sin solapar nada', async () => {
    const g = buildGraph(await parseSql(sample), vis);
    const pos = await autoLayout(g.nodes, g.edges);
    const box = (id: string) => {
      const s = estimateSize(g.nodes.find((n) => n.id === id)!);
      return { ...pos[id], w: s.width, h: s.height };
    };
    const ids = g.nodes.map((n) => n.id);
    expect(Object.keys(pos).sort()).toEqual([...ids].sort());

    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) {
        const a = box(ids[i]), b = box(ids[j]);
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        expect(overlap, `${ids[i]} se solapa con ${ids[j]}`).toBe(false);
      }

    // Un tipo usado por una sola tabla queda pegado a ella (varios tipos de la
    // misma tabla se reparten los huecos de alrededor).
    const users = new Map<string, string[]>();
    for (const e of g.edges) if (e.data?.rel === 'type') users.set(e.target, [...(users.get(e.target) ?? []), e.source]);
    for (const [ty, us] of users) {
      if (new Set(us).size !== 1) continue;
      const t = box(ty), u = box(us[0]);
      const dx = Math.max(u.x - (t.x + t.w), t.x - (u.x + u.w), 0);
      const dy = Math.max(u.y - (t.y + t.h), t.y - (u.y + u.h), 0);
      expect(Math.hypot(dx, dy), `${ty} lejos de ${us[0]}`).toBeLessThan(320);
    }
  });
});

const partSql = `
CREATE TABLE evento (id bigint, fecha timestamptz NOT NULL, usuario_id int REFERENCES usuario(id)) PARTITION BY RANGE (fecha);
CREATE TABLE usuario (id int PRIMARY KEY);
CREATE TABLE evento_2026_10 PARTITION OF evento FOR VALUES FROM ('2026-10-01 00:00:00+00') TO ('2026-11-01 00:00:00+00');
CREATE TABLE evento_2026_11 PARTITION OF evento FOR VALUES FROM ('2026-11-01 00:00:00+00') TO ('2026-12-01 00:00:00+00');
`;

describe('particiones', () => {
  it('por defecto se contraen dentro de la tabla madre', async () => {
    const g = buildGraph(await parseSql(partSql), vis);
    expect(g.nodes.map((n) => n.id).sort()).toEqual(['t:public.evento', 't:public.usuario']);
    expect(g.edges.some((e) => e.data?.rel === 'partition')).toBe(false);
    const ev = g.nodes.find((n) => n.id === 't:public.evento')!;
    expect(ev.data.kind === 'table' && ev.data.partitions.map((p) => p.name)).toEqual(['evento_2026_10', 'evento_2026_11']);
    expect(shortBound(ev.data.kind === 'table' ? ev.data.partitions[0].bound : '')).toBe('2026-10-01 → 2026-11-01');
  });

  it('como nodos, se apilan bajo su madre', async () => {
    const g = buildGraph(await parseSql(partSql), { ...vis, showPartitions: true });
    expect(g.nodes).toHaveLength(4);
    const pos = await autoLayout(g.nodes, g.edges);
    const h = (id: string) => estimateSize(g.nodes.find((n) => n.id === id)!).height;
    const ev = pos['t:public.evento'], p1 = pos['t:public.evento_2026_10'], p2 = pos['t:public.evento_2026_11'];
    expect(p1.x).toBeGreaterThan(ev.x);
    expect(p1.x - ev.x).toBeLessThan(60);
    expect(p1.y).toBeGreaterThanOrEqual(ev.y + h('t:public.evento'));
    expect(p2.x).toBe(p1.x);
    expect(p2.y).toBeGreaterThanOrEqual(p1.y + h('t:public.evento_2026_10'));
  });
});
