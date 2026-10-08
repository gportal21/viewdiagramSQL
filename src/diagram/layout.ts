import type { ELK as ElkInstance } from 'elkjs/lib/elk-api';
import type { EntityNode, RelEdge } from './build';
import { estimateSize } from './build';

// ELK pesa ~1,5 MB: se carga sólo cuando hace falta el primer layout.
let elkPromise: Promise<ElkInstance> | undefined;
const getElk = () =>
  (elkPromise ??= import('elkjs/lib/elk.bundled.js').then((m) => new m.default()));

export type Positions = Record<string, { x: number; y: number }>;

/**
 * Coloca los nodos con ELK (algoritmo por capas, de izquierda a derecha):
 * las tablas referenciadas quedan a la izquierda de las que las referencian,
 * y los componentes desconectados se empaquetan aparte.
 */
export async function autoLayout(nodes: EntityNode[], edges: RelEdge[]): Promise<Positions> {
  if (!nodes.length) return {};
  const ids = new Set(nodes.map((n) => n.id));
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
    children: nodes.map((n) => {
      const measured = n.measured?.width && n.measured?.height ? { width: n.measured.width, height: n.measured.height } : estimateSize(n);
      return { id: n.id, ...measured };
    }),
    // Invertimos la dirección: la tabla referenciada (padre) va a la izquierda.
    // Las aristas columna→tipo no participan: si no, cada tipo añade una capa
    // y el diagrama se estira en horizontal. Los tipos se empaquetan aparte.
    edges: edges
      .filter((e) => e.data?.rel !== 'type' && e.source !== e.target && ids.has(e.source) && ids.has(e.target))
      .map((e) => ({ id: e.id, sources: [e.target], targets: [e.source] })),
  };
  const elk = await getElk();
  const res = await elk.layout(graph);
  const out: Positions = {};
  for (const c of res.children ?? []) out[c.id] = { x: Math.round(c.x ?? 0), y: Math.round(c.y ?? 0) };
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
