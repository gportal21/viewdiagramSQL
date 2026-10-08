import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  getNodesBounds,
  getViewportForBounds,
  useNodesInitialized,
  useNodesState,
  useReactFlow,
  type InternalNode,
  type NodeMouseHandler,
} from '@xyflow/react';
import { toPng, toSvg } from 'html-to-image';
import type { Schema } from '../schema/model';
import { buildGraph, type EntityNode, type RelEdge, type Visibility } from './build';
import { autoLayout, placeNew, type Positions } from './layout';
import { nodeTypes, HEADER_HANDLE } from './nodes';
import { edgeTypes, MarkerDefs, type EdgeState } from './edges';

export interface DiagramHandle {
  relayout: () => Promise<void>;
  focus: (nodeId: string) => void;
  fit: () => void;
  exportImage: (format: 'png' | 'svg', fileName: string) => Promise<void>;
}

interface Props {
  schema: Schema;
  visibility: Visibility;
  positions: Positions;
  onPositionsChange: (p: Positions) => void;
  selectedId: string | null;
  onSelect: (nodeId: string | null) => void;
}

const Inner = forwardRef<DiagramHandle, Props>(function Inner(
  { schema, visibility, positions, onPositionsChange, selectedId, onSelect },
  ref,
) {
  const rf = useReactFlow<EntityNode, RelEdge>();
  const [nodes, setNodes, onNodesChange] = useNodesState<EntityNode>([]);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const positionsRef = useRef(positions);
  positionsRef.current = positions;
  const [pendingFit, setPendingFit] = useState(true);
  const initialized = useNodesInitialized();

  const graph = useMemo(() => buildGraph(schema, visibility), [schema, visibility]);

  // Reconstruye los nodos cuando cambia el esquema o los filtros, conservando posiciones.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const saved = positionsRef.current;
      const needsLayout = graph.nodes.some((n) => !saved[n.id]);
      const layout = needsLayout ? await autoLayout(graph.nodes, graph.edges) : {};
      if (cancelled) return;
      const pos = needsLayout ? placeNew(graph.nodes, saved, layout) : saved;
      setNodes((prev) => {
        const prevById = new Map(prev.map((n) => [n.id, n]));
        return graph.nodes.map((n) => ({
          ...n,
          position: pos[n.id] ?? prevById.get(n.id)?.position ?? { x: 0, y: 0 },
          selected: n.id === selectedId,
        }));
      });
      if (needsLayout) {
        const merged = { ...saved };
        for (const n of graph.nodes) merged[n.id] = pos[n.id];
        onPositionsChange(merged);
      }
      // Diagrama nuevo (ningún nodo tenía posición guardada): reencuadrar.
      if (needsLayout && graph.nodes.every((n) => !saved[n.id])) setPendingFit(true);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph]);

  // Encuadre inicial: esperamos a que React Flow haya medido los nodos.
  useEffect(() => {
    if (!pendingFit || !initialized || !nodes.length) return;
    setPendingFit(false);
    requestAnimationFrame(() => rf.fitView({ padding: 0.12, maxZoom: 1, duration: 0 }));
  }, [pendingFit, initialized, nodes.length, rf]);

  useEffect(() => {
    setNodes((ns) => ns.map((n) => (n.selected === (n.id === selectedId) ? n : { ...n, selected: n.id === selectedId })));
  }, [selectedId, setNodes]);

  // Nodos vecinos del seleccionado (o del que está bajo el cursor).
  const focusId = hoverId ?? selectedId;
  const related = useMemo(() => {
    if (!focusId) return null;
    const s = new Set<string>([focusId]);
    for (const e of graph.edges) {
      if (e.source === focusId) s.add(e.target);
      if (e.target === focusId) s.add(e.source);
    }
    return s;
  }, [focusId, graph.edges]);

  // Aristas: elegimos el lado (izq/der) de cada extremo según la posición actual.
  const edges = useMemo<RelEdge[]>(() => {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    return graph.edges.map((e) => {
      const a = byId.get(e.source);
      const b = byId.get(e.target);
      const aw = a?.measured?.width ?? 260;
      const bw = b?.measured?.width ?? 260;
      const ax = a?.position.x ?? 0;
      const bx = b?.position.x ?? 0;
      let sSide: 'L' | 'R';
      let tSide: 'L' | 'R';
      if (e.source === e.target) {
        sSide = 'R';
        tSide = 'R';
      } else if (ax + aw + 40 < bx) {
        sSide = 'R';
        tSide = 'L';
      } else if (bx + bw + 40 < ax) {
        sSide = 'L';
        tSide = 'R';
      } else {
        // Se solapan en horizontal: salimos por el mismo lado, el más cercano.
        sSide = tSide = ax + aw / 2 <= bx + bw / 2 ? 'L' : 'R';
      }
      const sCol = e.data?.sourceCol ?? HEADER_HANDLE;
      const tCol = e.data?.rel === 'fk' ? e.data?.targetCol ?? HEADER_HANDLE : HEADER_HANDLE;
      const state: EdgeState = !related ? 'normal' : related.has(e.source) && related.has(e.target) && (e.source === focusId || e.target === focusId) ? 'active' : 'dim';
      return {
        ...e,
        sourceHandle: `${sSide}:s:${sCol}`,
        targetHandle: `${tSide}:t:${tCol}`,
        zIndex: state === 'active' ? 10 : 0,
        data: { ...e.data!, state },
      };
    });
  }, [graph.edges, nodes, related, focusId]);

  const styledNodes = useMemo(
    () => (related ? nodes.map((n) => ({ ...n, className: related.has(n.id) ? '' : 'is-dim' })) : nodes),
    [nodes, related],
  );

  const savePositions = useCallback(() => {
    const p: Positions = { ...positionsRef.current };
    for (const n of rf.getNodes()) p[n.id] = { x: Math.round(n.position.x), y: Math.round(n.position.y) };
    onPositionsChange(p);
  }, [rf, onPositionsChange]);

  useImperativeHandle(
    ref,
    () => ({
      async relayout() {
        const current = rf.getNodes();
        const layout = await autoLayout(current, graph.edges);
        setNodes((ns) => ns.map((n) => ({ ...n, position: layout[n.id] ?? n.position })));
        onPositionsChange({ ...positionsRef.current, ...layout });
        requestAnimationFrame(() => rf.fitView({ padding: 0.15, maxZoom: 1, duration: 400 }));
      },
      focus(id) {
        const n = rf.getNode(id);
        if (!n) return;
        const w = n.measured?.width ?? 260;
        const h = n.measured?.height ?? 200;
        rf.setCenter(n.position.x + w / 2, n.position.y + h / 2, { zoom: Math.max(rf.getZoom(), 0.9), duration: 450 });
      },
      fit() {
        rf.fitView({ padding: 0.15, maxZoom: 1, duration: 400 });
      },
      async exportImage(format, fileName) {
        const all = rf.getNodes();
        if (!all.length) return;
        const bounds = getNodesBounds(all);
        const pad = 48;
        const scale = format === 'png' ? 2 : 1;
        const width = Math.min(Math.ceil(bounds.width + pad * 2), 16000);
        const height = Math.min(Math.ceil(bounds.height + pad * 2), 16000);
        const vp = getViewportForBounds(bounds, width, height, 0.05, 1, 0);
        const el = document.querySelector<HTMLElement>('.react-flow__viewport');
        if (!el) return;
        const bg = getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim() || '#fff';
        const opts = {
          backgroundColor: bg,
          width,
          height,
          pixelRatio: scale,
          style: { width: `${width}px`, height: `${height}px`, transform: `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})` },
          filter: (node: HTMLElement) => !node.classList?.contains('react-flow__minimap'),
        };
        // Las aristas usan marcadores definidos fuera del viewport: los copiamos dentro.
        const defs = document.querySelector('.marker-defs')?.cloneNode(true) as SVGElement | undefined;
        if (defs) el.prepend(defs);
        try {
          const url = format === 'png' ? await toPng(el, opts) : await toSvg(el, opts);
          const a = document.createElement('a');
          a.href = url;
          a.download = `${fileName}.${format}`;
          a.click();
        } finally {
          defs?.remove();
        }
      },
    }),
    [rf, graph.edges, setNodes, onPositionsChange],
  );

  const onNodeClick: NodeMouseHandler<EntityNode> = (_, n) => onSelect(n.id);

  return (
    <ReactFlow<EntityNode, RelEdge>
      nodes={styledNodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodesChange={onNodesChange}
      onNodeDragStop={savePositions}
      onNodeClick={onNodeClick}
      onNodeMouseEnter={(_, n) => setHoverId(n.id)}
      onNodeMouseLeave={() => setHoverId(null)}
      onPaneClick={() => onSelect(null)}
      connectionMode={ConnectionMode.Loose}
      nodesConnectable={false}
      elementsSelectable
      minZoom={0.08}
      maxZoom={2.5}
      onlyRenderVisibleElements={nodes.length > 150}
      proOptions={{ hideAttribution: true }}
      fitView={false}
    >
      <MarkerDefs />
      <Background variant={BackgroundVariant.Dots} gap={18} size={1.2} color="var(--grid)" />
      <Controls showInteractive={false} position="bottom-right" />
      <MiniMap
        pannable
        zoomable
        position="bottom-left"
        nodeColor={(n: InternalNode<EntityNode> | EntityNode) => {
          const d = (n as EntityNode).data;
          return d.kind === 'table' ? 'var(--mini-table)' : d.kind === 'view' ? 'var(--mini-view)' : 'var(--mini-type)';
        }}
        maskColor="var(--mini-mask)"
        bgColor="var(--panel)"
      />
    </ReactFlow>
  );
});

export const Diagram = forwardRef<DiagramHandle, Props>(function Diagram(props, ref) {
  return (
    <ReactFlowProvider>
      <Inner {...props} ref={ref} />
    </ReactFlowProvider>
  );
});
