import { memo } from 'react';
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, Position, type EdgeProps } from '@xyflow/react';
import type { RelEdge } from './build';

export type EdgeState = 'normal' | 'active' | 'dim';

/**
 * Notación pata de gallo (crow's foot):
 *  - lado de la FK: "muchos" (pata) o "uno" (barra), con círculo si admite NULL
 *  - lado referenciado: "uno y sólo uno" (doble barra)
 */
export function MarkerDefs() {
  const m = (id: string, color: string, children: React.ReactNode) => (
    <marker id={id} viewBox="0 0 24 24" markerWidth="24" markerHeight="24" refX="23" refY="12" orient="auto-start-reverse" markerUnits="userSpaceOnUse">
      <g fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round">{children}</g>
    </marker>
  );
  const sets: [string, string][] = [
    ['n', 'var(--edge)'],
    ['a', 'var(--edge-active)'],
  ];
  return (
    <svg className="marker-defs" aria-hidden="true">
      <defs>
        {sets.map(([s, c]) => (
          <g key={s}>
            {m(`one-${s}`, c, <><path d="M16 5v14" /><path d="M20 5v14" /></>)}
            {m(`many-${s}`, c, <><path d="M10 12L23 4" /><path d="M10 12L23 20" /><path d="M10 12h13" /><path d="M8 5v14" /></>)}
            {m(`many0-${s}`, c, <><path d="M12 12L23 4" /><path d="M12 12L23 20" /><path d="M12 12h11" /><circle cx="7" cy="12" r="3.6" fill="var(--canvas)" /></>)}
            {m(`one0-${s}`, c, <><path d="M18 5v14" /><circle cx="10" cy="12" r="3.6" fill="var(--canvas)" /></>)}
            <marker id={`tri-${s}`} viewBox="0 0 16 16" markerWidth="16" markerHeight="16" refX="15" refY="8" orient="auto" markerUnits="userSpaceOnUse">
              <path d="M2 2L15 8L2 14z" fill="var(--canvas)" stroke={c} strokeWidth="1.5" strokeLinejoin="round" />
            </marker>
            <marker id={`dot-${s}`} viewBox="0 0 10 10" markerWidth="10" markerHeight="10" refX="5" refY="5" markerUnits="userSpaceOnUse">
              <circle cx="5" cy="5" r="3" fill={s === 'a' ? 'var(--edge-active)' : 'var(--type-edge)'} />
            </marker>
          </g>
        ))}
      </defs>
    </svg>
  );
}

function RelEdgeView(props: EdgeProps<RelEdge>) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data } = props;
  const state = ((data as { state?: EdgeState } | undefined)?.state ?? 'normal') as EdgeState;
  const s = state === 'active' ? 'a' : 'n';
  const sameSide = sourcePosition === targetPosition;
  const [path, lx, ly] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 10,
    offset: sameSide ? 28 : 22,
  });

  let markerStart: string | undefined;
  let markerEnd: string | undefined;
  switch (data?.rel) {
    case 'fk':
      markerStart = `url(#${data.many ? (data.optional ? 'many0' : 'many') : data.optional ? 'one0' : 'one'}-${s})`;
      markerEnd = `url(#one-${s})`;
      break;
    case 'inherit':
    case 'partition':
      markerEnd = `url(#tri-${s})`;
      break;
    case 'type':
      markerEnd = `url(#dot-${s})`;
      break;
    default:
      markerEnd = `url(#tri-${s})`;
  }

  // Estilo inline (no sólo CSS): html-to-image no copia estilos de <path> SVG al exportar.
  const rel = data?.rel ?? 'fk';
  const style: React.CSSProperties = {
    stroke: state === 'active' ? 'var(--edge-active)' : rel === 'type' ? 'var(--type-edge)' : 'var(--edge)',
    strokeWidth: state === 'active' ? 2 : rel === 'type' ? 1.2 : 1.5,
    strokeDasharray: rel === 'type' ? '4 4' : rel === 'inherit' || rel === 'partition' ? '7 4' : rel === 'view' ? '2 4' : undefined,
    opacity: state === 'dim' ? 0.18 : 1,
    fill: 'none',
  };

  const showLabel = state === 'active' && (data?.label || data?.detail) && data?.rel !== 'type';
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerStart={markerStart}
        markerEnd={markerEnd}
        style={style}
        className={`rel rel-${rel} state-${state}`}
        interactionWidth={14}
      />
      {showLabel && (
        <EdgeLabelRenderer>
          <div className="edge-label" style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)` }}>
            {data?.label && <strong>{data.label}</strong>}
            {data?.detail && <span>{data.detail}</span>}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const edgeTypes = { rel: memo(RelEdgeView) };
export { Position };
