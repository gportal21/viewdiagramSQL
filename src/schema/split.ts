// Utilidades de texto previas al parser.

/**
 * Limpia lo que no es SQL pero aparece en dumps de pg_dump / scripts de psql:
 *  - meta-comandos de psql (`\connect`, `\restrict`, `\set`, ...)
 *  - bloques de datos `COPY ... FROM stdin;` hasta la línea `\.`
 * Se reemplazan por espacios conservando los saltos de línea, así los
 * números de línea de los errores siguen coincidiendo con el original.
 */
export function preprocess(sql: string): string {
  const lines = sql.split('\n');
  const blank = (s: string) => s.replace(/[^\r]/g, ' ');
  let inCopy = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (inCopy) {
      if (/^\\\.\s*\r?$/.test(line)) inCopy = false;
      lines[i] = blank(line);
      continue;
    }
    if (/^\s*\\/.test(line)) {
      lines[i] = blank(line);
      continue;
    }
    if (/^\s*COPY\s[\s\S]*\bFROM\s+stdin\b/i.test(line)) {
      // La sentencia COPY se conserva fuera: el parser la entiende, pero no aporta
      // nada al diagrama, así que la blanqueamos junto con sus datos.
      lines[i] = blank(line);
      inCopy = true;
    }
  }
  return lines.join('\n');
}

export interface Segment {
  text: string;
  /** Índice (en caracteres) donde empieza el segmento en el texto completo. */
  start: number;
}

/**
 * Divide un script en sentencias respetando comillas simples, E'' strings,
 * identificadores entre comillas dobles, dollar quoting ($$ / $tag$),
 * comentarios de línea y de bloque (anidados).
 */
export function splitStatements(sql: string): Segment[] {
  const out: Segment[] = [];
  let start = 0;
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === '-' && next === '-') {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? n : nl + 1;
      continue;
    }
    if (c === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') { depth++; i += 2; }
        else if (sql[i] === '*' && sql[i + 1] === '/') { depth--; i += 2; }
        else i++;
      }
      continue;
    }
    if (c === "'") {
      const escaped = i > 0 && /[eE]/.test(sql[i - 1]) && !/[\w$]/.test(sql[i - 2] ?? ' ');
      i++;
      while (i < n) {
        if (escaped && sql[i] === '\\') { i += 2; continue; }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { i += 2; continue; }
          break;
        }
        i++;
      }
      i++;
      continue;
    }
    if (c === '"') {
      i++;
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') { i += 2; continue; }
          break;
        }
        i++;
      }
      i++;
      continue;
    }
    if (c === '$') {
      const m = /^\$([A-Za-z_\u0080-￿][\w\u0080-￿]*)?\$/.exec(sql.slice(i, i + 64));
      if (m && !/[\w$]/.test(sql[i - 1] ?? ' ')) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        i = end === -1 ? n : end + tag.length;
        continue;
      }
    }
    if (c === ';') {
      out.push({ text: sql.slice(start, i + 1), start });
      start = i + 1;
    }
    i++;
  }
  if (sql.slice(start).trim()) out.push({ text: sql.slice(start), start });
  return out.filter((s) => s.text.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, '').trim().replace(/;$/, '').trim() !== '');
}

/** Convierte offsets en bytes UTF-8 (lo que devuelve libpg_query) a línea/columna. */
export class Locator {
  private bytes: Uint8Array;
  private lineStarts: number[] = [0];
  constructor(text: string) {
    this.bytes = new TextEncoder().encode(text);
    for (let i = 0; i < this.bytes.length; i++) if (this.bytes[i] === 10) this.lineStarts.push(i + 1);
  }
  /**
   * libpg_query sitúa cada sentencia justo después del `;` anterior; avanzamos
   * sobre espacios y comentarios para apuntar a la primera palabra real.
   */
  skipTrivia(byteOffset: number): number {
    const b = this.bytes;
    let i = byteOffset;
    while (i < b.length) {
      const c = b[i];
      if (c === 32 || c === 9 || c === 10 || c === 13 || c === 12) { i++; continue; }
      if (c === 45 && b[i + 1] === 45) { while (i < b.length && b[i] !== 10) i++; continue; }
      if (c === 47 && b[i + 1] === 42) {
        let depth = 1;
        i += 2;
        while (i < b.length && depth > 0) {
          if (b[i] === 47 && b[i + 1] === 42) { depth++; i += 2; }
          else if (b[i] === 42 && b[i + 1] === 47) { depth--; i += 2; }
          else i++;
        }
        continue;
      }
      break;
    }
    return i;
  }

  /** byteOffset base 0 → { line, column } base 1. */
  at(byteOffset: number): { line: number; column: number } {
    const off = Math.max(0, Math.min(byteOffset, this.bytes.length));
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid] <= off) lo = mid;
      else hi = mid - 1;
    }
    const lineStart = this.lineStarts[lo];
    const column = new TextDecoder().decode(this.bytes.subarray(lineStart, off)).length + 1;
    return { line: lo + 1, column };
  }
}

/** Offset en bytes UTF-8 de un índice de carácter. */
export function charToByte(text: string, charIndex: number): number {
  return new TextEncoder().encode(text.slice(0, charIndex)).length;
}
