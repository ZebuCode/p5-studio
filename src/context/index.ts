import * as vscode from 'vscode';
import { isLivePanelViewType, LIVE_PANEL_TITLE_PREFIX } from '../panels/registry';

export type ContextServiceDeps = {
  getActiveP5Panel: () => vscode.WebviewPanel | undefined;
  getDocUriForPanel: (panel: vscode.WebviewPanel) => vscode.Uri | undefined;
  updateVariablesPanel: () => void;
  getKidsModeDocUri?: () => string | undefined;
};

export type ContextServiceApi = {
  setContext: (key: string, val: any) => Thenable<unknown>;
  updateActiveContexts: () => void;
  setDebugPrimed: (docUri: string, value: boolean) => void;
  getDebugPrimed: (docUri: string) => boolean;
  setCaptureVisible: (docUri: string, value: boolean) => void;
  getCaptureVisible: (docUri: string) => boolean;
  setSteppingActive: (docUri: string, value: boolean) => void;
  getSteppingActive: (docUri: string) => boolean;
  setHasDraw: (docUri: string, value: boolean) => void;
  getHasDraw: (docUri: string) => boolean;
  setDrawLoopPaused: (docUri: string, value: boolean) => void;
  getDrawLoopPaused: (docUri: string) => boolean;
  clearForDoc: (docUri: string) => void;
  getInitialCaptureVisible: (panel: vscode.WebviewPanel) => boolean;
};

const debugPrimedMap = new Map<string, boolean>();
const captureVisibleMap = new Map<string, boolean>();
const steppingActiveMap = new Map<string, boolean>();
const hasDrawMap = new Map<string, boolean>();
const drawLoopPausedMap = new Map<string, boolean>();

export function registerContextService(
  context: vscode.ExtensionContext,
  deps: ContextServiceDeps,
): ContextServiceApi {
  const setContext = (key: string, val: any) => vscode.commands.executeCommand('setContext', key, val);

  function getDocUriForActivePanel(): vscode.Uri | undefined {
    const panel = deps.getActiveP5Panel();
    if (!panel) return undefined;
    try { return deps.getDocUriForPanel(panel); } catch { return undefined; }
  }

  function updateWebviewTabFocusedContext() {
    const activeTab = vscode.window.tabGroups.activeTabGroup?.activeTab;
    let isP5Webview = false;
    if (activeTab) {
      // try {
      //   console.log('[P5Studio] activeTab.label:', activeTab.label);
      //   console.log('[P5Studio] activeTab.input:', JSON.stringify(activeTab.input));
      // } catch (e) {
      //   console.log('[P5Studio] Error logging activeTab.input:', e);
      // }
      if (activeTab.label && activeTab.input) {
        const input = activeTab.input as { viewType?: string };
        const vt = (input && typeof input.viewType === 'string') ? String(input.viewType) : '';
        const looksLikeLiveP5 = isLivePanelViewType(vt);
        if (looksLikeLiveP5 && String(activeTab.label).startsWith(LIVE_PANEL_TITLE_PREFIX)) {
          isP5Webview = true;
        }
      }
    }
    setContext('p5WebviewTabFocused', isP5Webview);
    let docUriForContext: string | undefined;
    if (isP5Webview) {
      const uri = getDocUriForActivePanel();
      docUriForContext = uri ? uri.toString() : undefined;
    } else {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        docUriForContext = editor.document.uri.toString();
      } else if (typeof deps.getKidsModeDocUri === 'function') {
        try {
          const kidsUri = deps.getKidsModeDocUri();
          if (kidsUri) {
            docUriForContext = kidsUri;
          }
        } catch { /* ignore */ }
      }
    }
    const primed = docUriForContext ? !!debugPrimedMap.get(docUriForContext) : false;
    const cap = docUriForContext ? !!captureVisibleMap.get(docUriForContext) : false;
    const stepping = docUriForContext ? !!steppingActiveMap.get(docUriForContext) : false;
    const hasDraw = docUriForContext ? !!hasDrawMap.get(docUriForContext) : false;
    const loopPaused = (docUriForContext && hasDraw) ? !!drawLoopPausedMap.get(docUriForContext) : false;
    setContext('p5DebugPrimed', primed);
    setContext('p5CaptureVisible', cap);
    setContext('p5SteppingActive', stepping);
    setContext('p5HasDraw', hasDraw);
    setContext('p5DrawLoopPaused', loopPaused);
    deps.updateVariablesPanel();
  }

  // Watchers to keep contexts in sync with UI focus
  context.subscriptions.push(vscode.window.tabGroups.onDidChangeTabs(updateWebviewTabFocusedContext));
  context.subscriptions.push(vscode.window.tabGroups.onDidChangeTabGroups(updateWebviewTabFocusedContext));
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(updateWebviewTabFocusedContext));
  // Initialize
  updateWebviewTabFocusedContext();

  const api: ContextServiceApi = {
    setContext,
    updateActiveContexts: updateWebviewTabFocusedContext,
    setDebugPrimed: (docUri: string, value: boolean) => { try { debugPrimedMap.set(docUri, !!value); } catch { } },
    getDebugPrimed: (docUri: string) => { try { return !!debugPrimedMap.get(docUri); } catch { return false; } },
    setCaptureVisible: (docUri: string, value: boolean) => { try { captureVisibleMap.set(docUri, !!value); } catch { } },
    getCaptureVisible: (docUri: string) => { try { return !!captureVisibleMap.get(docUri); } catch { return false; } },
    setSteppingActive: (docUri: string, value: boolean) => {
      try { steppingActiveMap.set(docUri, !!value); } catch { }
      try {
        const activeUri = getDocUriForActivePanel();
        if (activeUri && activeUri.toString() === docUri) {
          setContext('p5SteppingActive', !!value);
        }
      } catch { }
    },
    getSteppingActive: (docUri: string) => { try { return !!steppingActiveMap.get(docUri); } catch { return false; } },
    setHasDraw: (docUri: string, value: boolean) => {
      try {
        if (value) hasDrawMap.set(docUri, true);
        else { hasDrawMap.set(docUri, false); drawLoopPausedMap.set(docUri, false); }
      } catch { }
      try {
        const activeUri = getDocUriForActivePanel();
        if (activeUri && activeUri.toString() === docUri) {
          setContext('p5HasDraw', !!value);
          setContext('p5DrawLoopPaused', value ? !!drawLoopPausedMap.get(docUri) : false);
        }
      } catch { }
    },
    getHasDraw: (docUri: string) => { try { return !!hasDrawMap.get(docUri); } catch { return false; } },
    setDrawLoopPaused: (docUri: string, value: boolean) => {
      try { drawLoopPausedMap.set(docUri, !!value); } catch { }
      try {
        const activeUri = getDocUriForActivePanel();
        if (activeUri && activeUri.toString() === docUri) {
          setContext('p5DrawLoopPaused', !!value && !!hasDrawMap.get(docUri));
        }
      } catch { }
    },
    getDrawLoopPaused: (docUri: string) => { try { return !!drawLoopPausedMap.get(docUri); } catch { return false; } },
    clearForDoc: (docUri: string) => {
      try {
        debugPrimedMap.delete(docUri);
        captureVisibleMap.delete(docUri);
        steppingActiveMap.delete(docUri);
        hasDrawMap.delete(docUri);
        drawLoopPausedMap.delete(docUri);
      } catch { }
    },
    getInitialCaptureVisible: (panel: vscode.WebviewPanel): boolean => {
      try {
        const uri = deps.getDocUriForPanel(panel);
        return uri ? !!captureVisibleMap.get(uri.toString()) : false;
      } catch {
        return false;
      }
    },
  };

  return api;
}
