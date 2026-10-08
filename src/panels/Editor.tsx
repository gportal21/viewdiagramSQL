import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import CodeMirror, { EditorView, type ReactCodeMirrorRef } from '@uiw/react-codemirror';
import { PostgreSQL, sql as sqlLang } from '@codemirror/lang-sql';
import { forceLinting, linter, lintGutter, type Diagnostic } from '@codemirror/lint';
import type { ParseIssue } from '../schema/model';

export interface EditorHandle {
  goToLine: (line: number, column?: number) => void;
}

interface Props {
  value: string;
  onChange: (v: string) => void;
  issues: ParseIssue[];
  dark: boolean;
}

const baseTheme = EditorView.theme({
  '&': { height: '100%', fontSize: '12.5px', backgroundColor: 'var(--panel)', color: 'var(--ink)' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6' },
  '.cm-gutters': { backgroundColor: 'var(--panel)', color: 'var(--faint)', borderRight: '1px solid var(--line)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--hover)' },
  '.cm-activeLine': { backgroundColor: 'var(--hover)' },
  '.cm-content': { caretColor: 'var(--accent)' },
  '&.cm-focused .cm-cursor': { borderLeftColor: 'var(--accent)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: 'var(--selection) !important' },
  '.cm-tooltip': { fontFamily: 'var(--font-ui)', fontSize: '12px' },
});

export const Editor = forwardRef<EditorHandle, Props>(function Editor({ value, onChange, issues, dark }, ref) {
  const cm = useRef<ReactCodeMirrorRef>(null);
  const issuesRef = useRef(issues);
  issuesRef.current = issues;

  useImperativeHandle(ref, () => ({
    goToLine(line, column = 1) {
      const view = cm.current?.view;
      if (!view) return;
      const l = view.state.doc.line(Math.min(Math.max(1, line), view.state.doc.lines));
      const pos = Math.min(l.from + Math.max(0, column - 1), l.to);
      view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
      view.focus();
    },
  }));

  const extensions = useMemo(
    () => [
      sqlLang({ dialect: PostgreSQL, upperCaseKeywords: false }),
      baseTheme,
      EditorView.lineWrapping,
      lintGutter(),
      linter(
        (view) => {
          const doc = view.state.doc;
          return issuesRef.current
            .filter((i) => i.line <= doc.lines)
            .map<Diagnostic>((i) => {
              const l = doc.line(i.line);
              const from = Math.min(l.from + Math.max(0, i.column - 1), l.to);
              const wordEnd = /^[\w$"']+/.exec(doc.sliceString(from, l.to))?.[0].length ?? 1;
              return {
                from,
                to: i.severity === 'error' ? Math.min(from + Math.max(wordEnd, 1), l.to) : l.to,
                severity: i.severity,
                message: i.message,
              };
            });
        },
        { delay: 0 },
      ),
    ],
    [],
  );

  // Los issues llegan tras el parseo (asíncrono): forzamos a recalcular los diagnósticos.
  useEffect(() => {
    const view = cm.current?.view;
    if (view) forceLinting(view);
  }, [issues]);

  return (
    <CodeMirror
      ref={cm}
      value={value}
      onChange={onChange}
      theme={dark ? 'dark' : 'light'}
      extensions={extensions}
      height="100%"
      className="editor"
      basicSetup={{ foldGutter: true, highlightActiveLine: true, autocompletion: true, searchKeymap: true }}
      placeholder="Pega aquí tu SQL de PostgreSQL (CREATE TABLE, CREATE TYPE ... AS ENUM, CREATE DOMAIN, ...)"
    />
  );
});
