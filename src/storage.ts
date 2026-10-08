import type { Visibility } from './diagram/build';
import type { Positions } from './diagram/layout';

const KEY = 'viewdiagramsql:v1';

export type ThemeMode = 'system' | 'light' | 'dark';

export interface Saved {
  sql: string;
  fileName: string;
  positions: Positions;
  visibility: Visibility;
  theme: ThemeMode;
  sidebarOpen: boolean;
  /** Ancho del panel SQL en px; null = ancho por defecto. */
  sidebarWidth: number | null;
}

export const defaultVisibility: Visibility = { hiddenSchemas: [], showTypes: true, showViews: true, showTypeEdges: true };

export function load(): Partial<Saved> {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Partial<Saved>) : {};
  } catch {
    return {};
  }
}

let timer: number | undefined;
let pending: Saved | undefined;

function write(state: Saved) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Cuota excedida (dumps muy grandes): guardamos sin el SQL.
    try {
      localStorage.setItem(KEY, JSON.stringify({ ...state, sql: '' }));
    } catch {
      /* sin almacenamiento disponible */
    }
  }
}

function flush() {
  window.clearTimeout(timer);
  if (pending) write(pending);
  pending = undefined;
}

// Al recargar o cerrar la pestaña se guarda lo pendiente sin esperar el debounce.
window.addEventListener('pagehide', flush);

export function save(state: Saved) {
  pending = state;
  window.clearTimeout(timer);
  timer = window.setTimeout(flush, 300);
}
