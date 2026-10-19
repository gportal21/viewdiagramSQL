import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseSql } from '../schema/parse';
import { buildGraph, estimateSize } from './build';
import { autoLayout } from './layout';

const sample = readFileSync(new URL('../sample.sql', import.meta.url), 'utf8');
const vis = { hiddenSchemas: [], showTypes: true, showEnums: true, showViews: true, showTypeEdges: true };

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
