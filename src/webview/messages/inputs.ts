import * as vscode from 'vscode';
import { detectDrawFunction } from '../../utils/helpers';
import type { VarControl } from '../../types';

export async function handleSubmitTopInputs(
  params: { panel: vscode.WebviewPanel; editor: vscode.TextEditor; values: any[] },
  deps: {
    detectTopLevelInputs: (code: string) => Array<{ varName: string; label?: string; defaultValue?: any }>;
    preprocessTopLevelInputs: (code: string, opts: { key: string; interactive: boolean }) => Promise<string>;
    setCachedInputsForKey: (key: string, items: Array<{ varName: string; label?: string }>, values: any[]) => void;
    wrapInSetupIfNeeded: (code: string) => string;
    extractGlobalVariables: (code: string) => Array<{ name: string; value: any; type: string; control?: VarControl; readonly?: boolean }>;
    extractGlobalVariablesWithConflicts: (code: string) => { globals: Array<{ name: string; value: any; type: string; control?: VarControl; readonly?: boolean }>; conflicts: string[] };
    rewriteUserCodeWithWindowGlobals: (code: string, globals: Array<{ name: string; value?: any; control?: VarControl; readonly?: boolean }>) => string;
    createHtml: (code: string, panel: vscode.WebviewPanel, extensionPath: string, opts?: { allowInteractiveTopInputs?: boolean; initialCaptureVisible?: boolean }) => Promise<string>;
    getInitialCaptureVisible: (panel: vscode.WebviewPanel) => boolean;
    getExtensionPath: () => string;
    getHiddenGlobalsByDirective: (code: string) => Set<string>;
    hasOnlySetup: (code: string) => boolean;
    getAllowInteractiveTopInputs: () => boolean;
    setAllowInteractiveTopInputs: (v: boolean) => void;
  }
) {
  const { panel, editor } = params;
  try {
    const rawCode = editor.document.getText();
    const key = editor.document.fileName;
    const items = deps.detectTopLevelInputs(rawCode);
    if (!Array.isArray(items) || items.length === 0) {
      panel.webview.postMessage({ type: 'hideTopInputs' });
      return;
    }
    const incoming: Record<string, any> = {};
    if (Array.isArray(params.values)) {
      for (const e of params.values) {
        if (e && typeof e.name === 'string') incoming[e.name] = e.value;
      }
    }
    const values: any[] = items.map(it => {
      const v = incoming[it.varName];
      if (typeof v === 'boolean') return v;
      if (typeof v === 'string') {
        const s = v.trim();
        const low = s.toLowerCase();
        if (low === 'true' || low === 'false') return low === 'true';
        const num = Number(s);
        if (!Number.isNaN(num) && s !== '') return num;
        return v;
      }
      if (typeof v === 'number') return v;
      return v;
    });
    deps.setCachedInputsForKey(key, items.map(i => ({ varName: i.varName, label: i.label })), values);

    // Preprocess non-interactively using the cache
    const prevFlag = deps.getAllowInteractiveTopInputs();
    deps.setAllowInteractiveTopInputs(false);
    let pre = rawCode;
    try {
      pre = await deps.preprocessTopLevelInputs(rawCode, { key, interactive: false });
    } finally {
      deps.setAllowInteractiveTopInputs(prevFlag);
    }
    // Syntax checks and run
    let code = deps.wrapInSetupIfNeeded(pre);
    const globals = deps.extractGlobalVariables(code);
    let rewrittenCode = deps.rewriteUserCodeWithWindowGlobals(code, globals);
    // Reload and then send globals
    panel.webview.postMessage({ type: 'hideTopInputs' });
    const hasDraw = detectDrawFunction(code);
    const extPath = deps.getExtensionPath();
    if (!hasDraw) {
      panel.webview.html = await deps.createHtml(code, panel, extPath, { allowInteractiveTopInputs: deps.getAllowInteractiveTopInputs(), initialCaptureVisible: deps.getInitialCaptureVisible(panel) });
      setTimeout(() => {
        const { globals } = deps.extractGlobalVariablesWithConflicts(code);
        let filteredGlobals = globals.filter(g => ['number', 'string', 'boolean', 'array'].includes(g.type));
        const hiddenSet = deps.getHiddenGlobalsByDirective(editor.document.getText());
        if (hiddenSet.size > 0) {
          filteredGlobals = filteredGlobals.filter(g => !hiddenSet.has(g.name));
        }
        const readOnly = deps.hasOnlySetup(editor.document.getText());
        panel.webview.postMessage({ type: 'setGlobalVars', variables: filteredGlobals, readOnly });
      }, 200);
    } else {
      panel.webview.postMessage({ type: 'reload', code: rewrittenCode, preserveGlobals: false });
      setTimeout(() => {
        const { globals } = deps.extractGlobalVariablesWithConflicts(code);
        let filteredGlobals = globals.filter(g => ['number', 'string', 'boolean', 'array'].includes(g.type));
        const hiddenSet = deps.getHiddenGlobalsByDirective(editor.document.getText());
        if (hiddenSet.size > 0) {
          filteredGlobals = filteredGlobals.filter(g => !hiddenSet.has(g.name));
        }
        const readOnly = deps.hasOnlySetup(editor.document.getText());
        panel.webview.postMessage({ type: 'setGlobalVars', variables: filteredGlobals, readOnly });
      }, 200);
    }
  } catch (e) {
    params.panel.webview.postMessage({ type: 'showError', message: 'Failed to apply input values: ' + e });
  }
}
