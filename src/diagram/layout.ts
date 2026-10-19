import type { ELK as ElkInstance } from 'elkjs/lib/elk-api';
import type { EntityNode, RelEdge } from './build';
import { estimateSize, rowOffset } from './build';

// ELK pesa ~1,5 MB: se carga sólo cuando hace falta el primer layout.
let elkPromise: Promise<ElkInstance> | undefined;
const getElk = () =>
  (elkPromise ??= import('elkjs/lib/elk.bundled.js').then((m) => new m.default()));

export type Positions = Record<string, { x: number; y: number }>;
type Size = { width: number; height: number };
type Box = { x: number; y: number; w: number; h: number };

const sizeOf = (n: EntityNode): Size =>
  n.measured?.width && n.measured?.height ? { width: n.measured.width, height: n.measured.height } : estimateSize(n);

/**
 * Coloca los nodos en dos fases:
 *
 * 1. Tablas y vistas con ELK (algoritmo por capas, de izquierda a derecha):
 *    las tablas referenciadas quedan a la izquierda de las que las referencian,
 *    y los componentes desconectados se empaquetan aparte.
 * 2. Tipos (enums, dominios, compuestos…) junto a las tablas que los usan,
 *    en el hueco libre más cercano (ver `placeTypes`). Si entraran en ELK,
 *    cada tipo añadiría una capa y el diagrama se estiraría en horizontal.
 */
export async function autoLayout(nodes: EntityNode[], edges: RelEdge[]): Promise<Positions> {
  if (!nodes.length) return {};
  const main = nodes.filter((n) => n.data.kind !== 'type');
  const types = nodes.filter((n) => n.data.kind === 'type');
  const ids = new Set(main.map((n) => n.id));
  const sizes = new Map(nodes.map((n) => [n.id, sizeOf(n)]));

  const out: Positions = {};
  if (main.length) {
    const graph = {
      id: 'root',
      layoutOptions: {
        'elk.algorithm': 'layered',
        'elk.direction': 'RIGHT',
        'elk.layered.spacing.nodeNodeBetweenLayers': '80',
        'elk.spacing.nodeNode': '36',
        'elk.spacing.componentComponent': '60',
        'elk.separateConnectedComponents': 'true',
        'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
        'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
        'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
        'elk.aspectRatio': '1.7',
      },
      children: main.map((n) => ({ id: n.id, ...sizes.get(n.id)! })),
      // Invertimos la dirección: la tabla referenciada (padre) va a la izquierda.
      edges: edges
        .filter((e) => e.data?.rel !== 'type' && e.source !== e.target && ids.has(e.source) && ids.has(e.target))
        .map((e) => ({ id: e.id, sources: [e.target], targets: [e.source] })),
    };
    const elk = await getElk();
    const res = await elk.layout(graph);
    for (const c of res.children ?? []) out[c.id] = { x: Math.round(c.x ?? 0), y: Math.round(c.y ?? 0) };
  }
  Object.assign(out, placeTypes(nodes, types, edges, out, sizes));
  return out;
}

const GAP = 28; // separación mínima entre un tipo y cualquier otro nodo
const STEP = 16; // resolución de la búsqueda de hueco

/**
 * Coloca cada tipo cerca de quien lo usa, sin solaparse con nada:
 *
 * - El punto ideal es el extremo derecho de la fila de la columna que lo usa
 *   (o el centro de esos puntos si lo usan varias tablas).
 * - Se busca, en anillos crecientes alrededor de ese punto, la primera
 *   posición libre; así cada tipo cae en el hueco más próximo a sus tablas.
 * - Primero los tipos usados por una sola tabla (son los que más ganan si
 *   quedan pegados a ella), luego los compartidos y al final los que sólo
 *   usan otros tipos. Los que no usa nadie se apilan debajo de todo.
 */
function placeTypes(all: EntityNode[], types: EntityNode[], edges: RelEdge[], placed: Positions, sizes: Map<string, Size>): Positions {
  const out: Positions = {};
  if (!types.length) return out;
  const byId = new Map(all.map((n) => [n.id, n]));
  const typeIds = new Set(types.map((n) => n.id));
  const boxes: Box[] = Object.entries(placed).map(([id, p]) => ({ x: p.x, y: p.y, w: sizes.get(id)!.width, h: sizes.get(id)!.height }));

  // Quién usa cada tipo: aristas columna→tipo (desde tablas o desde otros tipos).
  const users = new Map<string, { node: string; col?: string }[]>(types.map((t) => [t.id, []]));
  for (const e of edges) {
    if (e.data?.rel !== 'type' || !typeIds.has(e.target) || e.source === e.target) continue;
    users.get(e.target)!.push({ node: e.source, col: e.data.sourceCol });
  }

  const pos = (id: string) => placed[id] ?? out[id];
  const free = (b: Box) => boxes.every((o) => b.x >= o.x + o.w + GAP || o.x >= b.x + b.w + GAP || b.y >= o.y + o.h + GAP || o.y >= b.y + b.h + GAP);

  /** Primera posición libre en anillos crecientes alrededor de (x, y). */
  const nearestFree = (x: number, y: number, s: Size): { x: number; y: number } | undefined => {
    for (let k = 0; k <= 200; k++) {
      const ring: [number, number][] = [];
      for (let i = -k; i <= k; i++) {
        ring.push([i, -k], [i, k]);
        if (i !== -k && i !== k) ring.push([-k, i], [k, i]);
      }
      if (k === 0) ring.splice(1);
      // Dentro del anillo, lo más cercano primero; a igual distancia, a la derecha.
      ring.sort((a, b) => a[0] ** 2 + a[1] ** 2 - (b[0] ** 2 + b[1] ** 2) || b[0] - a[0]);
      for (const [dx, dy] of ring) {
        const b = { x: x + dx * STEP, y: y + dy * STEP, w: s.width, h: s.height };
        if (free(b)) return { x: b.x, y: b.y };
      }
    }
    return undefined;
  };

  const place = (t: EntityNode, x: number, y: number) => {
    const s = sizes.get(t.id)!;
    const p = nearestFree(Math.round(x), Math.round(y), s) ?? { x: Math.round(x), y: bottom() + GAP };
    out[t.id] = p;
    boxes.push({ x: p.x, y: p.y, w: s.width, h: s.height });
  };
  const bottom = () => (boxes.length ? Math.max(...boxes.map((b) => b.y + b.h)) : 0);

  const pending = [...types];
  // Varias pasadas: un tipo usado sólo por otro tipo espera a que éste tenga sitio.
  for (let pass = 0; pass < 4 && pending.length; pass++) {
    const ready = pending
      .map((t) => ({ t, us: users.get(t.id)!.filter((u) => pos(u.node)) }))
      .filter((r) => r.us.length)
      .sort((a, b) => a.us.length - b.us.length);
    for (const { t, us } of ready) {
      const s = sizes.get(t.id)!;
      // Ancla: borde derecho de cada fila que usa el tipo.
      const anchors = us.map((u) => {
        const n = byId.get(u.node)!;
        const p = pos(u.node)!;
        return { x: p.x + sizes.get(u.node)!.width, y: p.y + rowOffset(n, u.col) };
      });
      const ax = anchors.reduce((a, b) => a + b.x, 0) / anchors.length;
      const ay = anchors.reduce((a, b) => a + b.y, 0) / anchors.length;
      // Ideal: la cabecera del tipo a la altura de la fila, un poco a la derecha.
      place(t, us.length === 1 ? ax + GAP : ax - s.width / 2, us.length === 1 ? ay - 20 : ay - s.height / 2);
      pending.splice(pending.indexOf(t), 1);
    }
  }

  // Tipos que no usa nadie: en fila debajo de todo.
  let x = boxes.length ? Math.min(...boxes.map((b) => b.x)) : 0;
  const y = boxes.length ? bottom() + 60 : 0;
  for (const t of pending) {
    const s = sizes.get(t.id)!;
    out[t.id] = { x, y };
    x += s.width + GAP;
  }
  return out;
}

/** Coloca nodos nuevos debajo de lo existente sin mover los que ya tienen posición. */
export function placeNew(nodes: EntityNode[], saved: Positions, layout: Positions): Positions {
  const out: Positions = {};
  const missing = nodes.filter((n) => !saved[n.id]);
  for (const n of nodes) if (saved[n.id]) out[n.id] = saved[n.id];
  if (!missing.length) return out;
  if (missing.length === nodes.length) return layout;
  // Desplazamos el bloque nuevo por debajo del contenido existente.
  const maxY = Math.max(...Object.values(out).map((p) => p.y)) + 420;
  const minX = Math.min(...Object.values(out).map((p) => p.x));
  const ly = Math.min(...missing.map((n) => layout[n.id]?.y ?? 0));
  const lx = Math.min(...missing.map((n) => layout[n.id]?.x ?? 0));
  for (const n of missing) {
    const p = layout[n.id] ?? { x: 0, y: 0 };
    out[n.id] = { x: minX + (p.x - lx), y: maxY + (p.y - ly) };
  }
  return out;
}
