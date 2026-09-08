import * as vscode from 'vscode';

export function handleSetGlobalVars(
  params: {
    panel: vscode.WebviewPanel;
    editor: vscode.TextEditor;
    variables: Array<{ name: string; value: any; type: string; updatedAt?: number; readonly?: boolean }>;
    generatedAt?: number;
  },
  deps: {
    setGlobalsForDoc: (docUri: string, list: Array<{ name: string; value: any; type: string; updatedAt?: number; readonly?: boolean }>, opts?: { generatedAt?: number }) => void;
    updateVariablesPanel: () => void;
    isActivePanel: (panel: vscode.WebviewPanel) => boolean;
  }
) {
  try {
    const thisDocUri = params.editor.document.uri.toString();
    const list = Array.isArray(params.variables) ? params.variables : [];
    deps.setGlobalsForDoc(thisDocUri, list, { generatedAt: params.generatedAt });
    if (deps.isActivePanel(params.panel)) {
      deps.updateVariablesPanel();
    }
  } catch {
    deps.updateVariablesPanel();
  }
}

export function handleUpdateGlobalVar(
  params: {
    panel: vscode.WebviewPanel;
    editor: vscode.TextEditor;
    name: string;
    value: any;
    generatedAt?: number;
    scope?: 'globals' | 'locals';
  },
  deps: {
    getGlobalsForDoc: (docUri: string) => Array<{ name: string; value: any; type: string; readonly?: boolean }>;
    getLocalsForDoc: (docUri: string) => Array<{ name: string; value: any; type: string }>;
    setGlobalValue: (docUri: string, name: string, value: any, opts?: { updatedAt?: number }) => void;
    hasGlobalDefinition: (docUri: string, name: string) => boolean;
    upsertLocal: (docUri: string, v: { name: string; value: any; type: string }) => void;
    updateVariablesPanel: () => void;
    isActivePanel: (panel: vscode.WebviewPanel) => boolean;
  }
) {
  try {
    const thisDocUri = params.editor.document.uri.toString();
    if (params.scope === 'locals') {
      let forcedType = 'string';
      try {
        if (Array.isArray(params.value)) forcedType = 'array';
        else if (typeof params.value === 'number') forcedType = 'number';
        else if (typeof params.value === 'boolean') forcedType = 'boolean';
        else if (params.value && typeof params.value === 'object') forcedType = 'object';
      } catch { }
      deps.upsertLocal(thisDocUri, { name: String(params.name), value: params.value, type: forcedType });
      if (deps.isActivePanel(params.panel)) deps.updateVariablesPanel();
      return;
    }
    const globals = deps.getGlobalsForDoc(thisDocUri) || [];
    const isGlobal = globals.some(v => v.name === params.name) || deps.hasGlobalDefinition(thisDocUri, params.name);
    if (isGlobal) {
      deps.setGlobalValue(thisDocUri, params.name, params.value, { updatedAt: params.generatedAt });
    } else {
      let type = 'string';
      try {
        if (Array.isArray(params.value)) type = 'array';
        else if (typeof params.value === 'number') type = 'number';
        else if (typeof params.value === 'boolean') type = 'boolean';
      } catch { }
      deps.upsertLocal(thisDocUri, { name: String(params.name), value: params.value, type });
    }
    if (deps.isActivePanel(params.panel)) deps.updateVariablesPanel();
  } catch {
    deps.updateVariablesPanel();
  }
}
