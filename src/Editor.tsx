import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import FormatWorker from './format-worker?worker';
import { defaultCodeStyle, generatedStyle, type CodeStyle } from './codeStyle';
import { completeSQL } from './completion';
import type { DatabaseEngine, SchemaIndex } from './shared';

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
monaco.editor.defineTheme('studio', {
  base: 'vs-dark', inherit: true,
  rules: [
    { token: 'keyword', foreground: 'CC7832' },
    { token: 'string', foreground: '6AAB73' },
    { token: 'number', foreground: '2AACB8' },
    { token: 'comment', foreground: '7A7E85', fontStyle: 'italic' },
    { token: 'operator', foreground: 'BCBEC4' },
  ],
  colors: { 'editor.background': '#1E1F22', 'editor.foreground': '#BCBEC4', 'editorLineNumber.foreground': '#606366', 'editorLineNumber.activeForeground': '#A4A7AD', 'editor.lineHighlightBackground': '#26282E', 'editor.selectionBackground': '#214283', 'editorCursor.foreground': '#BBBBBB', 'editorIndentGuide.background1': '#313438', 'editorWidget.background': '#2B2D30' },
});

export interface EditorHandle { selection(): string; focus(): void; format(): Promise<void> }
interface Props { value: string; onChange(value: string): void; onRun(sql: string): void; onError(message: string): void; engine: DatabaseEngine; driverId?: string; codeStyle?: CodeStyle; getSchema(sql: string, offset: number): Promise<SchemaIndex | undefined> }
export const SqlEditor = forwardRef<EditorHandle, Props>(function SqlEditor({ value, onChange, onRun, onError, engine, driverId, codeStyle = defaultCodeStyle, getSchema }, ref) {
  const container = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const callbacks = useRef({ onChange, onRun, onError, engine, driverId, codeStyle, getSchema });
  callbacks.current = { onChange, onRun, onError, engine, driverId, codeStyle, getSchema };
  const formatting = useRef<(() => void) | undefined>(undefined);
  async function formatEditor() {
    const instance = editor.current, model = instance?.getModel();
    if (!instance || !model || formatting.current) return;
    const version = model.getVersionId(), selection = instance.getSelection();
    const range = selection && !selection.isEmpty() ? selection : model.getFullModelRange();
    const worker = new FormatWorker();
    const finish = () => { clearTimeout(timeout); worker.terminate(); formatting.current = undefined; };
    const timeout = setTimeout(() => { finish(); callbacks.current.onError('Форматирование превысило 3 секунды. SQL не изменён.'); }, 3000);
    formatting.current = finish;
    worker.onerror = () => { finish(); callbacks.current.onError('Ошибка форматирования. SQL не изменён.'); };
    worker.onmessage = ({ data }) => {
      finish();
      if (model.isDisposed() || editor.current !== instance) return;
      if (data.error) { callbacks.current.onError(data.error); return; }
      if (version !== model.getVersionId()) { callbacks.current.onError('SQL изменился во время форматирования. Повторите действие.'); return; }
      instance.pushUndoStop(); instance.executeEdits('format-sql', [{ range, text: data.value }]); instance.pushUndoStop(); instance.focus();
    };
    const { engine, driverId, codeStyle } = callbacks.current;
    worker.postMessage({ sql: model.getValueInRange(range), engine, driverId, style: codeStyle });
  }
  useImperativeHandle(ref, () => ({
    selection: () => {
      const selected = editor.current?.getSelection();
      return (selected && editor.current?.getModel()?.getValueInRange(selected)) || editor.current?.getValue() || '';
    },
    focus: () => editor.current?.focus(),
    format: formatEditor,
  }));
  useEffect(() => {
    editor.current?.getModel()?.updateOptions({ tabSize: codeStyle.indentSize, indentSize: codeStyle.indentSize, insertSpaces: !codeStyle.useTabs });
  }, [codeStyle]);
  useEffect(() => {
    const instance = monaco.editor.create(container.current!, {
      value, language: 'sql', theme: 'studio', fontSize: 13, lineHeight: 22,
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
      minimap: { enabled: false }, automaticLayout: true, scrollBeyondLastLine: false,
      padding: { top: 12, bottom: 12 }, lineNumbersMinChars: 4, renderLineHighlight: 'line',
      roundedSelection: false, smoothScrolling: true, tabSize: 4, wordWrap: 'off', rulers: [120],
      fixedOverflowWidgets: true, ariaLabel: 'SQL-редактор',
      quickSuggestions: { other: true, comments: false, strings: false },
      suggestOnTriggerCharacters: true, wordBasedSuggestions: 'off', tabCompletion: 'on',
    });
    editor.current = instance;
    const change = instance.onDidChangeModelContent(() => callbacks.current.onChange(instance.getValue()));
    const action = instance.addAction({
      id: 'studio.run', label: 'Выполнить SQL', keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
      run: () => {
        const selection = instance.getSelection();
        callbacks.current.onRun((selection && instance.getModel()?.getValueInRange(selection)) || instance.getValue());
      },
    });
    const formatAction = instance.addAction({ id: 'studio.format', label: 'Форматировать SQL', keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyL], run: formatEditor });
    instance.getModel()?.updateOptions({ tabSize: codeStyle.indentSize, indentSize: codeStyle.indentSize, insertSpaces: !codeStyle.useTabs });
    const completion = monaco.languages.registerCompletionItemProvider('sql', {
      triggerCharacters: ['.', ' '],
      async provideCompletionItems(model, position, _context, token) {
        if (model !== instance.getModel()) return { suggestions: [] };
        const version = model.getVersionId();
        const sql = model.getValue();
        const offset = model.getOffsetAt(position);
        const { engine, getSchema } = callbacks.current;
        const index = await getSchema(sql, offset);
        if (!index || token.isCancellationRequested || model.isDisposed() || version !== model.getVersionId()) return { suggestions: [] };
        const kinds = { column: monaco.languages.CompletionItemKind.Field, table: monaco.languages.CompletionItemKind.Class, join: monaco.languages.CompletionItemKind.Reference, keyword: monaco.languages.CompletionItemKind.Keyword };
        return { suggestions: completeSQL(sql, offset, index, engine).map(item => {
          const start = model.getPositionAt(item.start); const end = model.getPositionAt(item.end);
          const insertText = item.kind === 'keyword' || item.kind === 'join' ? generatedStyle(item.insertText, engine, callbacks.current.codeStyle) : item.insertText;
          return { label: item.label, insertText, detail: item.detail, documentation: insertText, kind: kinds[item.kind], filterText: item.filterText,
            sortText: `${item.rank}:${item.label}`, range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column) };
        }) };
      },
    });
    return () => { formatting.current?.(); formatAction.dispose(); completion.dispose(); change.dispose(); action.dispose(); instance.getModel()?.dispose(); instance.dispose(); editor.current = null; };
  }, []);
  return <div className="sql-editor" ref={container} />;
});
