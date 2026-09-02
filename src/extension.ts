import * as path from 'path';
import * as vscode from 'vscode';
import type { WebviewToExtensionMessage, ExtensionToWebviewMessage } from './webview/messageTypes';
import { postMessage as sendToWebview } from './webview/router';
import * as fs from 'fs';
import * as crypto from 'crypto';
// Modularized helpers and constants
import { getTime, toLocalISOString, detectDrawFunction } from './utils/helpers';
import { RESERVED_GLOBALS } from './constants';
import { extractGlobalVariablesWithConflicts, extractGlobalVariables, rewriteUserCodeWithWindowGlobals } from './processing/codeRewriter';
import { detectTopLevelInputs, hasNonTopInputUsage, preprocessTopLevelInputs, hasCachedInputsForKey, getCachedInputsForKey, setCachedInputsForKey } from './processing/topInputs';
import { createHtml } from './webview/createHtml';
import { rewriteFrameCountRefs, wrapInSetupIfNeeded, formatSyntaxErrorMsg, stripLeadingTimestamp, hasOnlySetup, getHiddenGlobalsByDirective } from './processing/astHelpers';
import { clearStepHighlight, applyStepHighlight } from './editors/stepHighlight';
import { instrumentSetupForSingleStep, instrumentRuntimeLineTracking } from './processing/instrumentation';
import { OscServiceApi } from './osc/oscService';
import { registerVariablesService, VariablesServiceApi } from './variables';
import { registerTriggersService, TriggersServiceApi } from './triggers';
import { registerBlockly, BlocklyApi } from './blockly/blocklyPanel';
import { registerLinting, LintApi } from './lint';
import { registerRestoreManager, RESTORE_BLOCKLY_KEY, RESTORE_LIVE_KEY, RESTORE_LIVE_ORDER_KEY } from './restore/restoreManager';
import { registerAutoReload, AutoReloadApi } from './reload/autoReload';
import { runOnActivate, hideFileIfSupported, refreshJsconfigIfMarkerPresent } from './project/setup';
import { getOrCreateOutputChannel, showAndTrackOutputChannel, getOutputChannelForDoc, disposeOutputForDoc, getLastActiveOutputChannel } from './logging/output';
import { registerLivePanelManager, LivePanelManagerApi } from './panels/livePanel';
import { livePanelTitleForFile, LIVE_PANEL_TITLE_PREFIX } from './panels/registry';
import { resolveLiveAssets } from './assets/resolver';
import { config as cfg } from './config/index';
import { setHtmlAndPost } from './webview/helpers';
import { prepareSketch, validateSource, ReloadReason } from './processing/sketchPrep';
import { injectLoopGuards } from './processing/loopGuards';
import { extractTriggers } from './processing/triggers';
// Commands groups
import { registerDebugCommands } from './commands/debug';
import { registerCaptureCommands } from './commands/capture';
import { registerUICommands } from './commands/ui';
import { registerHelpCommands } from './commands/help';
import { registerBlocklyCommands } from './commands/blockly';
import { registerLiveCommands } from './commands/live';
import { handleSetGlobalVars, handleUpdateGlobalVar } from './webview/messages/vars';
import { handleCaptureVisibilityChanged } from './webview/messages/capture';
import { handleLog } from './webview/messages/log';
import { handleShowError } from './webview/messages/error';
import { handleShowInfo } from './webview/messages/info';
import { handleOscSend } from './webview/messages/osc';
import { handleFocusScriptTab } from './webview/messages/focus';
import { handleCopyCanvasImage } from './webview/messages/image';
import { handleSubmitTopInputs } from './webview/messages/inputs';
import { handleReloadClicked } from './webview/messages/reload';
import { handleStepRunClicked, handleSingleStepClicked, handleContinueClicked } from './webview/messages/step';
import { handleHighlightLine, handleClearHighlight } from './webview/messages/highlight';
import { handleSaveCanvasImage } from './webview/messages/saveImage';
import { hasBreakpointOnLine } from './debug/breakpoints';
import { registerContextService, ContextServiceApi } from './context';
import { registerLayoutRestore, LayoutRestoreApi } from './layout';

const fsp = fs.promises;

const webviewPanelMap = new Map<string, vscode.WebviewPanel>();
let activeP5Panel: vscode.WebviewPanel | null = null;
let kidsModeEnabled = cfg.getBlocklyKidsMode();
let blocklyFeatureEnabled = cfg.getBlocklyEnabled();
const kidsModeInFlightDocs = new Set<string>();
const kidsModeManagedDocs = new Set<string>();
let activeKidsModeDocUri: string | null = null;
let suppressKidsModeAutoOpen = false;
const suppressedPanelDisposalPaths = new Set<string>();
const pendingKidsDocClosures = new Set<string>();

// Context service for context keys and focus watchers
let contextService: ContextServiceApi;

// Project marker: whether the workspace is configured for P5 (detected via jsconfig projectType)
let hasP5Project: boolean = false;

// Layout/Restore service for panel positioning and startup restore
let layoutService: LayoutRestoreApi;

// Step highlight helpers
let _allowInteractiveTopInputs = true;
// Track reason for last reload/update to alter input overlay behavior
let _pendingReloadReason: 'typing' | 'save' | 'command' | undefined;

// Helper to compute initial capture visibility for a webview panel from saved state
function getInitialCaptureVisible(panel: vscode.WebviewPanel): boolean {
  try { return contextService?.getInitialCaptureVisible(panel) || false; } catch { return false; }
}

// Command to clear highlight, for use with keybinding
function registerClearHighlightCommand(context: vscode.ExtensionContext) {
  context.subscriptions.push(vscode.commands.registerCommand('p5studio.clearHighlightEsc', async () => {
    clearStepHighlight(vscode.window.activeTextEditor);
  }));
}

// ----------------------------
// Activate
// ----------------------------
export function activate(context: vscode.ExtensionContext) {
  // Make p5/builtin globals visible to the linter via globalThis hook
  try { (globalThis as any).RESERVED_GLOBALS = RESERVED_GLOBALS; } catch { }
  // Variables SERVICE
  let variablesService: VariablesServiceApi;
  // TRIGGERS SERVICE
  let triggersService: TriggersServiceApi;
  // OSC service is now started/stopped manually via status bar
  let oscService: OscServiceApi | null = null;
  const updateShowFpsContext = (value: boolean) => {
    void vscode.commands.executeCommand('setContext', 'p5ShowFPS', !!value);
  };
  updateShowFpsContext(cfg.getShowFPS());
  const broadcastOscToPanels = (address: string, args: any[]) => {
    for (const [, panel] of webviewPanelMap.entries()) {
      try {
        sendToWebview(panel, { type: 'oscReceive', address, args });
      } catch { }
    }
  };

  // --- OSC Status Bar Button ---
  const oscStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  oscStatusBar.command = 'P5Studio.toggleOscServer';
  const oscCfg = cfg.getOscConfig() ?? { localAddress: '127.0.0.1', localPort: 57121, remoteAddress: '127.0.0.1', remotePort: 57122 };
  oscStatusBar.text = '▶️ Start OSC';
  oscStatusBar.tooltip = `Start OSC server \nListen on: ${oscCfg.localAddress}:${oscCfg.localPort} \nSend to: ${oscCfg.remoteAddress}:${oscCfg.remotePort}`;
  function setOscStatusBarColor() {
    const theme = vscode.window.activeColorTheme;
    // VS Code API does not expose theme name directly; fallback to document.body.className if available
    let themeName = '';
    try {
      // @ts-ignore
      themeName = (typeof document !== 'undefined' && document.body && document.body.className) ? document.body.className.toLowerCase() : '';
    } catch { }
    const statusBarBg = vscode.workspace.getConfiguration('workbench').get('colorCustomizations')?.['statusBar.background'];
    if (theme.kind === vscode.ColorThemeKind.Dark) {
      // Force white for all dark themes with default background
      if (statusBarBg === '#1e1e1e' || !statusBarBg) {
        oscStatusBar.color = '#ffffff';
      } else {
        oscStatusBar.color = '#ffffff'; // white for colored status bar
      }
    } else if (theme.kind === vscode.ColorThemeKind.Light) {
      oscStatusBar.color = '#000000'; // black for light
    } else {
      oscStatusBar.color = '#ffffff'; // white for high-contrast or colored status bar
    }
  }
  setOscStatusBarColor();
  vscode.window.onDidChangeActiveColorTheme(() => {
    setOscStatusBarColor();
    updateOscStatusBar();
  });
  context.subscriptions.push(oscStatusBar);
  oscStatusBar.show();

  let oscRunning = false;
  function updateOscStatusBar() {
    // Theme-aware color logic for both running and stopped states
    // VS Code API does not expose theme name directly; fallback to document.body.className if available
    let themeName = '';
    try {
      // @ts-ignore
      themeName = (typeof document !== 'undefined' && document.body && document.body.className) ? document.body.className.toLowerCase() : '';
    } catch { }
    const statusBarBg = vscode.workspace.getConfiguration('workbench').get('colorCustomizations')?.['statusBar.background'];
    let color = '#307dc1'; // default blue for dark
    const theme = vscode.window.activeColorTheme;
    if (theme.kind === vscode.ColorThemeKind.Dark) {
      // Force white for all dark themes with default background
      if (statusBarBg === '#1e1e1e' || !statusBarBg) {
        color = '#ffffff';
      } else {
        color = '#ffffff'; // white for colored status bar
      }
    } else if (theme.kind === vscode.ColorThemeKind.Light) {
      color = '#000000'; // black for light
    } else {
      color = '#ffffff'; // white for high-contrast or colored status bar
    }

    if (oscRunning && oscService && typeof oscService.getConfig === 'function') {
      const runningCfg = oscService.getConfig();
      oscStatusBar.text = '🛑 Stop OSC';
      oscStatusBar.tooltip = `Server is running\nListening on: ${runningCfg.localAddress}:${runningCfg.localPort}\nSending to: ${runningCfg.remoteAddress}:${runningCfg.remotePort}`;
      oscStatusBar.color = color;
    } else {
      const oscCfg = cfg.getOscConfig() ?? { localAddress: '127.0.0.1', localPort: 57121, remoteAddress: '127.0.0.1', remotePort: 57122 };
      oscStatusBar.text = '▶️ Start OSC';
      oscStatusBar.tooltip = `Start OSC server\nListen on: ${oscCfg.localAddress}:${oscCfg.localPort}\nSend to: ${oscCfg.remoteAddress}:${oscCfg.remotePort}`;
      oscStatusBar.color = color;
    }
  }

  async function startOscServer(
    localAddressOverride?: string,
    localPortOverride?: number,
    remoteAddressOverride?: string,
    remotePortOverride?: number
  ) {
    if (oscService) return;
    let usedConfig;
    if (
      typeof localAddressOverride === 'string' ||
      typeof localPortOverride === 'number' ||
      typeof remoteAddressOverride === 'string' ||
      typeof remotePortOverride === 'number'
    ) {
      // At least one override provided: use explicit values (fallback to undefined for missing)
      oscService = require('./osc/oscService').initOsc(broadcastOscToPanels, {
        localAddress: localAddressOverride,
        localPort: localPortOverride,
        remoteAddress: remoteAddressOverride,
        remotePort: remotePortOverride
      });
      usedConfig = {
        localAddress: localAddressOverride,
        localPort: localPortOverride,
        remoteAddress: remoteAddressOverride,
        remotePort: remotePortOverride
      };
    } else {
      // No overrides: let oscService use its own config logic
      oscService = require('./osc/oscService').initOsc(broadcastOscToPanels);
      // For status message, get config from oscService after start
      usedConfig = oscService && typeof oscService.getConfig === 'function' ? oscService.getConfig() : undefined;
    }
    oscRunning = true;
    updateOscStatusBar();
    if (usedConfig) {
      vscode.window.setStatusBarMessage(`OSC server started on ${usedConfig.localAddress}:${usedConfig.localPort} → ${usedConfig.remoteAddress}:${usedConfig.remotePort}`, 2000);
    } else {
      vscode.window.setStatusBarMessage('OSC server started', 2000);
    }
  }

  async function stopOscServer() {
    if (!oscService) return;
    try { oscService.dispose(); } catch { }
    oscService = null;
    oscRunning = false;
    updateOscStatusBar();
    vscode.window.setStatusBarMessage('OSC server stopped', 2000);
  }

  context.subscriptions.push(vscode.commands.registerCommand('P5Studio.toggleOscServer', async () => {
    if (oscRunning) {
      await stopOscServer();
    } else {
      await startOscServer();
    }
  }));

  // (No auto-start of OSC server)
  // Helper: find active P5 panel
  function getActiveP5Panel(): vscode.WebviewPanel | undefined {
    // 0) Prefer whichever panel VS Code currently reports as active. This works across detached windows.
    try {
      for (const [, panel] of webviewPanelMap.entries()) {
        if (panel?.active) {
          return panel;
        }
      }
    } catch { }
    // 1) If a webview tab is focused, resolve by matching the tab label to a panel title
    try {
      const activeTab = vscode.window.tabGroups.activeTabGroup?.activeTab;
      const activeLabel = activeTab && activeTab.label ? String(activeTab.label) : '';
      if (activeLabel) {
        for (const [, p] of webviewPanelMap.entries()) {
          try { if (p.title === activeLabel) return p; } catch { }
        }
      }
    } catch { }
    // 2) If an editor is active, find by its URI
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor) {
      const p = webviewPanelMap.get(activeEditor.document.uri.toString());
      if (p) return p;
    }
    // 3) Fall back to the last known active panel
    if (activeP5Panel) return activeP5Panel || undefined;
    return undefined;
  }

  async function invokeStepRun(panel: vscode.WebviewPanel, editor: vscode.TextEditor) {
    try { sendToWebview(panel, { type: 'invokeStepRun' }); } catch { }
  }
  async function invokeContinue(panel: vscode.WebviewPanel, editor: vscode.TextEditor) {
    try { sendToWebview(panel, { type: 'invokeContinue' }); } catch { }
  }
  async function invokeSingleStep(panel: vscode.WebviewPanel, editor: vscode.TextEditor) {
    try { sendToWebview(panel, { type: 'invokeSingleStep' }); } catch { }
  }
  async function invokeReload(panel: vscode.WebviewPanel, opts?: { preserveGlobals?: boolean }) {
    const preserveGlobals = opts?.preserveGlobals !== false;
    try { sendToWebview(panel, { type: 'invokeReload', preserveGlobals }); } catch { }
  }

  async function performPanelReload(panel: vscode.WebviewPanel, opts?: { preserveGlobals?: boolean; resetVariablesPanelToCodeInitials?: boolean }) {
    const uri = getDocUriForPanel(panel);
    const uriStr = uri ? uri.toString() : undefined;
    if (uriStr) {
      resetDebugStateForDoc(uriStr);
    }

    // If this reload was initiated via "Refresh" (VS Code title bar or custom context menu),
    // force the Variables panel to reset its sliders to the *code-defined* initial values.
    // Otherwise, the panel can appear to "not reset" because live updates resume quickly.
    try {
      if (opts?.resetVariablesPanelToCodeInitials && uriStr) {
        const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uriStr);
        const raw = doc ? doc.getText() : undefined;
        if (typeof raw === 'string') {
          const globalsInfo = extractGlobalVariablesWithConflicts(raw);
          let filteredGlobals = globalsInfo.globals
            .filter((g: any) => g && typeof g.name === 'string')
            .filter((g: any) => ['number', 'string', 'boolean', 'array'].includes(g.type));
          const hiddenSet = getHiddenGlobalsByDirective(raw);
          if (hiddenSet && hiddenSet.size > 0) {
            filteredGlobals = filteredGlobals.filter((g: any) => !hiddenSet.has(g.name));
          }
          const now = Date.now();
          variablesService.setGlobalsForDoc(uriStr, filteredGlobals.map((g: any) => ({
            name: g.name,
            value: g.value,
            type: g.type,
            control: g.control,
            updatedAt: now,
          })), { generatedAt: now });
          variablesService.resetValuesForDoc(uriStr);
          try { variablesService.requestPanelRebuildForDoc(uriStr); } catch { }
          updateVariablesPanel();
        }
      }
    } catch { /* ignore */ }

    try { (panel as any)._steppingActive = false; } catch { }
    if ((panel as any)._autoStepTimer) {
      try { clearInterval((panel as any)._autoStepTimer); } catch { }
      (panel as any)._autoStepTimer = null;
    }
    (panel as any)._autoStepMode = false;
    await invokeReload(panel, opts);
  }

  function resetDebugStateForDoc(docUri?: string) {
    if (!docUri) return;
    try { contextService.setDebugPrimed(docUri, false); } catch { }
    try { contextService.setSteppingActive(docUri, false); } catch { }
    try { contextService.setContext('p5DebugPrimed', false); } catch { }
    try { contextService.setContext('p5SteppingActive', false); } catch { }
    try {
      const editorToClear = vscode.window.visibleTextEditors.find(ed => ed.document?.uri?.toString() === docUri);
      if (editorToClear) {
        clearStepHighlight(editorToClear);
      }
    } catch { }
    try { blocklyApi.clearHighlight(docUri); } catch { }
    const panel = webviewPanelMap.get(docUri);
    if (panel) {
      try { (panel as any)._steppingActive = false; } catch { }
    }
  }
  async function toggleCapture(panel: vscode.WebviewPanel) {
    sendToWebview(panel, { type: 'toggleCaptureVisibility' });
  }

  // Register commands for editor/title buttons
  // Map a webview panel back to its originating document URI
  function getDocUriForPanel(panel: vscode.WebviewPanel | undefined): vscode.Uri | undefined {
    if (!panel) return undefined;
    for (const [uriStr, p] of webviewPanelMap.entries()) {
      if (p === panel) {
        try { return vscode.Uri.parse(uriStr); } catch { return undefined; }
      }
    }
    return undefined;
  }

  // Initialize Variables service (wraps view + storage)
  variablesService = registerVariablesService(context, {
    getActiveP5Panel: () => getActiveP5Panel(),
    getDocUriForPanel: (p) => getDocUriForPanel(p),
  });
  const updateVariablesPanel = () => { try { variablesService.updateVariablesPanel(); } catch { } };

  // Initialize TRIGGERS service (wraps view + storage)
  triggersService = registerTriggersService(context, {
    getActiveP5Panel: () => getActiveP5Panel(),
    getDocUriForPanel: (p) => getDocUriForPanel(p),
    invokeTrigger: (panel, fnName, args) => {
      try {
        const coerceArg = (v: any) => {
          if (typeof v !== 'string') return v;
          const s = v.trim();
          if (s === '') return v;
          if (s === 'true') return true;
          if (s === 'false') return false;
          if (s === 'null') return null;
          // numeric-looking (supports comma decimal and scientific notation)
          let numCandidate = s;
          const commaCount = (numCandidate.match(/,/g) || []).length;
          const hasDot = numCandidate.indexOf('.') !== -1;
          if (commaCount === 1 && !hasDot) {
            numCandidate = numCandidate.replace(',', '.');
          }
          if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(numCandidate)) {
            const n = Number(numCandidate);
            if (Number.isFinite(n)) return n;
          }
          return v;
        };
        const safeArgs = Array.isArray(args) ? args.map(coerceArg) : [];
        sendToWebview(panel, { type: 'invokeTrigger', fnName, args: safeArgs });
      } catch { }
    },
  });
  const updateTriggersPanel = () => { try { triggersService.updateTriggersPanel(); } catch { } };

  const syncTriggersForEditor = (editor?: vscode.TextEditor) => {
    if (!editor) return;
    try {
      const docUri = editor.document.uri.toString();
      const text = editor.document.getText();
      const triggers = extractTriggers(text);
      triggersService.setTriggersForDoc(docUri, triggers);
      updateTriggersPanel();
    } catch { }
  };

  const syncLocalsHeadingForEditor = (editor?: vscode.TextEditor) => {
    if (!editor) return;
    try {
      const docUri = editor.document.uri.toString();
      const text = editor.document.getText();
      const hasSetup = /\bfunction\s+setup\s*\(/.test(text);
      const hasDraw = /\bfunction\s+draw\s*\(/.test(text);
      const heading: 'locals' | 'variables' = (!hasSetup && !hasDraw) ? 'variables' : 'locals';
      variablesService.setLocalsHeadingForDoc(docUri, heading);
      variablesService.setHasDrawForDoc(docUri, hasDraw);
      updateVariablesPanel();
    } catch { }
  };

  // Initialize context service now that we can update the Variables panel
  contextService = registerContextService(context, {
    getActiveP5Panel: () => getActiveP5Panel(),
    getDocUriForPanel: (p) => getDocUriForPanel(p),
    updateVariablesPanel: () => updateVariablesPanel(),
  });

  // Register command groups
  registerDebugCommands(context, {
    getActiveP5Panel: () => getActiveP5Panel(),
    getDocUriForPanel: (p) => getDocUriForPanel(p),
    invokeStepRun: (panel, editor) => invokeStepRun(panel, editor),
    invokeContinue: (panel, editor) => invokeContinue(panel, editor),
    invokeSingleStep: (panel, editor) => invokeSingleStep(panel, editor),
    contextService,
  });
  registerCaptureCommands(context, {
    getActiveP5Panel: () => getActiveP5Panel(),
    toggleCapture: (panel) => toggleCapture(panel),
  });
  registerUICommands(context, {
    LIVE_PANEL_TITLE_PREFIX,
    webviewPanelMap,
  });
  registerHelpCommands(context);
  registerBlocklyCommands(context);

  context.subscriptions.push(vscode.commands.registerCommand('P5Studio.reloadWebpanel', async () => {
    const panel = getActiveP5Panel();
    if (!panel) return;
    await performPanelReload(panel, { resetVariablesPanelToCodeInitials: true });
  }));

  context.subscriptions.push(vscode.commands.registerCommand('P5Studio.pauseDrawLoop', async () => {
    const panel = getActiveP5Panel();
    if (!panel) return;
    const docUri = getDocUriForPanel(panel);
    if (!docUri) return;
    const docUriStr = docUri.toString();
    try {
      if (!contextService?.getHasDraw(docUriStr)) return;
    } catch { /* ignore */ }
    try { sendToWebview(panel, { type: 'pauseDrawLoop' }); } catch { }
    try { contextService?.setDrawLoopPaused(docUriStr, true); } catch { }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('P5Studio.resumeDrawLoop', async () => {
    const panel = getActiveP5Panel();
    if (!panel) return;
    const docUri = getDocUriForPanel(panel);
    if (!docUri) return;
    const docUriStr = docUri.toString();
    try {
      if (!contextService?.getHasDraw(docUriStr)) return;
    } catch { /* ignore */ }
    try { sendToWebview(panel, { type: 'resumeDrawLoop' }); } catch { }
    try { contextService?.setDrawLoopPaused(docUriStr, false); } catch { }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('P5Studio.stopStepping', async () => {
    const panel = getActiveP5Panel();
    if (!panel) return;
    try {
      const docUri = getDocUriForPanel(panel)?.toString();
      if (docUri) {
        // If stepping paused a draw-loop sketch, ensure it resumes when stopping debugging.
        try {
          const hasDraw = contextService?.getHasDraw?.(docUri);
          if (hasDraw) {
            try { sendToWebview(panel, { type: 'resumeDrawLoop' }); } catch { }
            try { contextService?.setDrawLoopPaused(docUri, false); } catch { }
          }
        } catch { }

        // Clear editor-line highlight for the sketch tied to this panel
        const edToClear = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === docUri);
        try { if (edToClear) clearStepHighlight(edToClear); } catch { }
        // Clear any Blockly block highlight for this document
        try { (blocklyApi as any)?.clearHighlight?.(docUri); } catch { }
        // Immediately drop stepping/debug UI state for this doc
        try { contextService.setSteppingActive(docUri, false); } catch { }
        try { contextService.setDebugPrimed(docUri, false); } catch { }
        try { contextService.setContext('p5SteppingActive', false); } catch { }
        try { contextService.setContext('p5DebugPrimed', false); } catch { }
        try { variablesService.resetValuesForDoc(docUri); } catch { }
        updateVariablesPanel();
      }
    } catch { }
    await performPanelReload(panel);
  }));
  registerClearHighlightCommand(context);

  // Helper to update the p5WebviewTabFocused context key
  function updateP5WebviewTabContext() {
    try { contextService?.updateActiveContexts(); } catch { }
  }

  // --- Lightweight restore manager ---
  const restore = registerRestoreManager(context);

  // Workspace-aware helpers (avoid cross-project restore)
  function workspaceRoots(): string[] {
    try { return (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath); } catch { return []; }
  }
  function isInWorkspace(fsPath: string): boolean {
    try {
      if (!fsPath) return false;
      const roots = workspaceRoots();
      if (!roots.length) return false;
      const norm = fsPath.replace(/\\/g, '/').toLowerCase();
      return roots.some(r => norm.startsWith(r.replace(/\\/g, '/').toLowerCase() + '/'));
    } catch { return false; }
  }

  // Register Blockly feature and obtain API hooks
  const blocklyApi: BlocklyApi = registerBlockly(context, {
    addToRestore: restore.addToRestore,
    removeFromRestore: restore.removeFromRestore,
    RESTORE_BLOCKLY_KEY,
    updateP5WebviewTabContext,
    notifyKidsModeFocus: (docUri, isActive) => {
      void updateKidsModeToolbarContext(docUri, isActive);
    },
    notifyPanelDisposed: (docUri) => {
      if (!docUri) return;
      kidsModeManagedDocs.delete(docUri);
      if (activeKidsModeDocUri === docUri) {
        void updateKidsModeToolbarContext(undefined, false);
      }
    },
  });

  // Linting: delegated to src/lint
  const lintApi: LintApi = registerLinting(context, {
    getOrCreateOutputChannel,
    getPanelForDocUri: (docUri: string) => webviewPanelMap.get(docUri),
    getTime,
  });

  // Cleanup: clear any pre-existing lint diagnostics for documents without a P5 panel
  try {
    for (const doc of vscode.workspace.textDocuments || []) {
      const uriStr = doc.uri.toString();
      if (doc.uri.scheme === 'file' && !webviewPanelMap.has(uriStr)) {
        try { lintApi.clearDiagnosticsForDocument(doc.uri); } catch { }
      }
    }
  } catch { /* ignore */ }

  function lintActiveEditor() {
    const ed = vscode.window.activeTextEditor;
    if (ed) {
      // Only lint documents that have an associated P5 panel
      const docUri = ed.document.uri.toString();
      if (webviewPanelMap.has(docUri)) {
        lintApi.lintAll(ed.document);
      }
    }
  }

  // Helper to update context key for p5.js file detection
  function updateP5Context(editor?: vscode.TextEditor) {
    editor = editor || vscode.window.activeTextEditor;
    if (!editor) return vscode.commands.executeCommand('setContext', 'isP5js', false);
    const isJsOrTs = ['javascript', 'typescript'].includes(editor.document.languageId);
    vscode.commands.executeCommand('setContext', 'isP5js', isJsOrTs);
  }

  // Status bar button for P5 Reference
  const p5RefStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
  p5RefStatusBar.command = 'extension.openP5Ref';
  p5RefStatusBar.text = '$(book) P5.js Reference'; // Status bar text
  p5RefStatusBar.tooltip = '$(book) Open P5.js Reference'; // Tooltip text
  p5RefStatusBar.color = '#ed225d';
  p5RefStatusBar.tooltip = '$(book) Open P5.js Reference';
  context.subscriptions.push(p5RefStatusBar);
  p5RefStatusBar.show();

  // Track all open panels to robustly close them on document close (even if untracked)
  const panelManager: LivePanelManagerApi = registerLivePanelManager(context, {
    webviewPanelMap,
    getOutputChannelForDoc,
    showAndTrackOutputChannel,
    disposeOutputForDoc,
  });

  // Helper to update context key for JS/TS file detection and show/hide status bar
  function updateJsOrTsContext(editor?: vscode.TextEditor) {
    editor = editor || vscode.window.activeTextEditor;
    const isJsOrTs = !!editor && ['javascript', 'typescript'].includes(editor.document.languageId);
    vscode.commands.executeCommand('setContext', 'isJsOrTs', isJsOrTs);
    // Show status bar only when in JS/TS AND the workspace is recognized as a P5 project
    if (isJsOrTs && hasP5Project) p5RefStatusBar.show(); else p5RefStatusBar.hide();
  }

  function isBlocklyEligibleDocument(doc?: vscode.TextDocument): boolean {
    if (!doc) return false;
    try {
      if (!['javascript', 'typescript'].includes(doc.languageId)) return false;
      const text = doc.getText();
      const isEmpty = text.trim().length === 0;
      let hasSidecar = false;
      let hasEmbedded = false;
      if (!isEmpty) {
        const sidecarPath = getBlocklySidecarPath(doc.fileName);
        hasSidecar = !!(sidecarPath && fs.existsSync(sidecarPath));
        if (!hasSidecar) {
          hasEmbedded = /\/\*@BlocklyWorkspace[\s\S]*?\*\//.test(text);
        }
      }
      return isEmpty || hasSidecar || hasEmbedded;
    } catch {
      return false;
    }
  }

  function updateBlocklyAvailability(editor?: vscode.TextEditor) {
    const doc = (editor || vscode.window.activeTextEditor)?.document;
    const eligible = isBlocklyEligibleDocument(doc);
    vscode.commands.executeCommand('setContext', 'p5BlocklyEligible', eligible);
  }

  function isKidsModeFeatureEnabled(): boolean {
    return kidsModeEnabled && blocklyFeatureEnabled;
  }

  async function closeEditorTabForDoc(docUri: string) {
    let normalizedPath: string | undefined;
    try {
      const uri = vscode.Uri.parse(docUri);
      if (uri.scheme === 'file') {
        normalizedPath = panelManager.normalizeFsPath(uri.fsPath);
      }
    } catch {
      normalizedPath = undefined;
    }

    let releasedSuppression = false;
    const releaseSuppression = () => {
      if (releasedSuppression || !normalizedPath) return;
      releasedSuppression = true;
      setTimeout(() => suppressedPanelDisposalPaths.delete(normalizedPath!), 300);
    };
    if (normalizedPath) {
      suppressedPanelDisposalPaths.add(normalizedPath);
    }

    const tryCloseViaTabs = async () => {
      if (!normalizedPath) return false;
      try {
        const groups: readonly vscode.TabGroup[] = (vscode.window.tabGroups as any).all || [vscode.window.tabGroups.activeTabGroup];
        const tabsToClose: vscode.Tab[] = [];
        for (const group of groups || []) {
          for (const tab of group?.tabs || []) {
            try {
              const tabPath = panelManager.fsPathFromTab(tab);
              if (tabPath && tabPath === normalizedPath) {
                tabsToClose.push(tab);
              }
            } catch { }
          }
        }
        if (!tabsToClose.length) return false;
        await vscode.window.tabGroups.close(tabsToClose, true);
        return true;
      } catch {
        return false;
      }
    };

    try {
      if (await tryCloseViaTabs()) {
        return;
      }

      const activeUri = vscode.window.activeTextEditor?.document?.uri?.toString();
      if (activeUri === docUri) {
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        return;
      }
      const targetEditor = vscode.window.visibleTextEditors.find(ed => ed.document?.uri?.toString() === docUri);
      if (targetEditor) {
        await vscode.window.showTextDocument(targetEditor.document, { preview: false, preserveFocus: false });
        if (vscode.window.activeTextEditor?.document?.uri?.toString() === docUri) {
          await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        }
      }
    } catch {
      // Ignore failures; VS Code may reject close commands when no editor is active.
    } finally {
      releaseSuppression();
    }
  }

  async function ensureEditorForDocUri(docUri: string): Promise<vscode.TextEditor | undefined> {
    try {
      const existing = vscode.window.visibleTextEditors.find(ed => ed.document?.uri?.toString() === docUri);
      if (existing) {
        return existing;
      }
      const uri = vscode.Uri.parse(docUri);
      const doc = await vscode.workspace.openTextDocument(uri);
      return vscode.window.showTextDocument(doc, {
        preview: false,
        preserveFocus: true,
        viewColumn: vscode.ViewColumn.One,
      });
    } catch {
      return undefined;
    }
  }

  async function openDocumentSilently(docUri: string): Promise<vscode.TextDocument | undefined> {
    try {
      const existing = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === docUri && !doc.isClosed);
      if (existing) {
        return existing;
      }
      const uri = vscode.Uri.parse(docUri);
      return vscode.workspace.openTextDocument(uri);
    } catch {
      return undefined;
    }
  }

  async function updateKidsModeToolbarContext(docUri: string | undefined, isActive: boolean) {
    const shouldActivate = !!docUri && isActive && isKidsModeFeatureEnabled() && kidsModeManagedDocs.has(docUri);
    if (shouldActivate) {
      activeKidsModeDocUri = docUri;
      await vscode.commands.executeCommand('setContext', 'p5BlocklyKidsModeActive', true);
      const hasPanel = webviewPanelMap.has(docUri);
      await vscode.commands.executeCommand('setContext', 'hasP5Webview', hasPanel);
      return;
    }
    if (!activeKidsModeDocUri) {
      return;
    }
    if (docUri && docUri !== activeKidsModeDocUri) {
      return;
    }
    activeKidsModeDocUri = null;
    await vscode.commands.executeCommand('setContext', 'p5BlocklyKidsModeActive', false);
    if (!vscode.window.activeTextEditor) {
      await vscode.commands.executeCommand('setContext', 'hasP5Webview', false);
    }
  }

  async function maybeActivateKidsMode(editor?: vscode.TextEditor) {
    if (!editor || !isKidsModeFeatureEnabled() || suppressKidsModeAutoOpen) return;
    try {
      const doc = editor.document;
      if (doc.isUntitled) return;
      if (doc.uri.scheme !== 'file') return;
      if (!doc.fileName.toLowerCase().endsWith('.js')) return;
      if (!isBlocklyEligibleDocument(doc)) return;
      const docUri = doc.uri.toString();
      if (kidsModeInFlightDocs.has(docUri)) return;
      kidsModeManagedDocs.add(docUri);
      kidsModeInFlightDocs.add(docUri);
      try {
        await vscode.commands.executeCommand('extension.open-blockly');
        try { blocklyApi?.revealPanelForDocUri?.(docUri, { preserveFocus: false }); } catch { }
        await closeEditorTabForDoc(docUri);
      } finally {
        kidsModeInFlightDocs.delete(docUri);
      }
    } catch {
      // Ignore kids mode automation failures to avoid disrupting editing.
    }
  }

  updateP5Context();
  updateJsOrTsContext();
  updateBlocklyAvailability();
  // Run initial semicolon lint on the active editor
  lintActiveEditor();


  async function updateJsconfigTimestamps() {
    try {
      const folders = vscode.workspace.workspaceFolders || [];
      if (!folders.length) return;
      const nowIso = toLocalISOString(new Date());
      for (const folder of folders) {
        const jsconfigPath = path.join(folder.uri.fsPath, 'jsconfig.json');
        try {
          const raw = await fsp.readFile(jsconfigPath, 'utf8');
          let parsed: any;
          try {
            parsed = JSON.parse(raw);
          } catch {
            continue;
          }
          if (!parsed || typeof parsed !== 'object') continue;
          if (parsed.createdAt === nowIso) continue;
          parsed.createdAt = nowIso;
          const endingNewline = raw.endsWith('\n') ? '\n' : '';
          const serialized = JSON.stringify(parsed, null, 2) + endingNewline;
          await fsp.writeFile(jsconfigPath, serialized, 'utf8');
        } catch {
          continue;
        }
      }
    } catch {
      /* ignore */
    }
  }


  // Detect whether the workspace has a jsconfig.json with projectType: 'p5js' and set context
  function updateP5ProjectContext() {
    try {
      let found = false;
      const folders = vscode.workspace.workspaceFolders || [];
      if (folders.length > 0) {
        const jsconfigPath = path.join(folders[0].uri.fsPath, 'jsconfig.json');
        if (fs.existsSync(jsconfigPath)) {
          try {
            const jsconfigRaw = fs.readFileSync(jsconfigPath, 'utf8');
            const jsconfig = JSON.parse(jsconfigRaw);
            const projectType = typeof jsconfig?.projectType === 'string' ? jsconfig.projectType.toLowerCase() : '';
            if (projectType === 'p5' || projectType === 'p5js') {
              found = true;
            }
          } catch { /* ignore parse errors */ }
        }
      }
      hasP5Project = found;
      vscode.commands.executeCommand('setContext', 'hasP5Project', hasP5Project);
      // Re-evaluate status bar visibility
      updateJsOrTsContext();
    } catch { /* ignore */ }
  }
  updateP5ProjectContext();
  // Watch for jsconfig.json creation/deletion/changes and workspace folder changes
  try {
    const watcher = vscode.workspace.createFileSystemWatcher('**/jsconfig.json');
    context.subscriptions.push(watcher.onDidCreate(() => updateP5ProjectContext()));
    context.subscriptions.push(watcher.onDidDelete(() => updateP5ProjectContext()));
    context.subscriptions.push(watcher.onDidChange(() => updateP5ProjectContext()));
    context.subscriptions.push(watcher);
  } catch { /* ignore */ }
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => updateP5ProjectContext()));

  (async () => { try { await updateJsconfigTimestamps(); } catch { } })();

  // Apply P5Studio editor font size (if configured) on activation
  try {
    const configuredSize = cfg.getEditorFontSize();
    if (typeof configuredSize === 'number' && configuredSize > 0) {
      const editorCfg = vscode.workspace.getConfiguration('editor');
      const currentSize = editorCfg.get<number>('fontSize');
      if (currentSize !== configuredSize) {
        editorCfg.update('fontSize', configuredSize, vscode.ConfigurationTarget.Global);
      }
    }
  } catch { }

  // Layout/Restore service wiring and startup restore
  layoutService = registerLayoutRestore(context, {
    restore: { migrate: restore.migrate, getRestoreList: restore.getRestoreList },
    RESTORE_LIVE_KEY,
    RESTORE_BLOCKLY_KEY,
    RESTORE_LIVE_ORDER_KEY,
    isInWorkspace: (p) => isInWorkspace(p),
    isSingleP5PanelEnabled: () => isSingleP5PanelEnabled(),
    openLiveForFsPath: async (fsPath: string) => {
      if (!fs.existsSync(fsPath)) return;
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fsPath));
      const docUri = doc.uri.toString();
      const previousSuppress = suppressKidsModeAutoOpen;
      suppressKidsModeAutoOpen = true;
      try {
        await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false, viewColumn: vscode.ViewColumn.One });
        await vscode.commands.executeCommand('extension.live-p5');
      } finally {
        suppressKidsModeAutoOpen = previousSuppress;
      }
      if (isKidsModeFeatureEnabled()) {
        pendingKidsDocClosures.delete(docUri);
        try { await closeEditorTabForDoc(docUri); } catch { }
      }
    },
    openBlocklyForFsPath: async (fsPath: string) => {
      if (!fs.existsSync(fsPath)) return;
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fsPath));
      const docUri = doc.uri.toString();
      const previousSuppress = suppressKidsModeAutoOpen;
      suppressKidsModeAutoOpen = true;
      try {
        await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false, viewColumn: vscode.ViewColumn.One });
        await vscode.commands.executeCommand('extension.open-blockly');
      } finally {
        suppressKidsModeAutoOpen = previousSuppress;
      }
      if (isKidsModeFeatureEnabled()) {
        pendingKidsDocClosures.add(docUri);
      }
    },
  });
  // Kick off restore asynchronously
  (async () => {
    try { await layoutService.beginRestore(); } catch { }
    finally {
      if (pendingKidsDocClosures.size) {
        const pending = Array.from(pendingKidsDocClosures);
        pendingKidsDocClosures.clear();
        for (const docUri of pending) {
          try { await closeEditorTabForDoc(docUri); } catch { }
        }
      }
    }
  })();

  let _lastStepHighlightEditor: vscode.TextEditor | undefined;
  let _kidsModeTemporarilyDisabled = false;
  vscode.window.onDidChangeActiveTextEditor(async (editor) => {
    // --- Update context keys for active document only ---
    let steppingActive = false;
    let debugPrimed = false;
    if (editor && editor.document) {
      const docUri = editor.document.uri.toString();
      steppingActive = contextService?.getSteppingActive?.(docUri) || false;
      debugPrimed = contextService?.getDebugPrimed?.(docUri) || false;
      await contextService.setContext('p5SteppingActive', steppingActive);
      await contextService.setContext('p5DebugPrimed', debugPrimed);
    } else {
      // No editor or not a document: always revert to non-debug state
      await contextService.setContext('p5SteppingActive', false);
      await contextService.setContext('p5DebugPrimed', false);
    }

    // --- Existing logic ---
    // Clear highlight in the previously active editor (if any)
    if (_lastStepHighlightEditor && _lastStepHighlightEditor !== editor) {
      clearStepHighlight(_lastStepHighlightEditor);
      try {
        const prevDocUri = _lastStepHighlightEditor.document?.uri?.toString();
        if (prevDocUri) { try { blocklyApi.clearHighlight(prevDocUri); } catch { } }
        // If stepping was active for the previous panel, fully reload it so a future debug prime starts from the beginning
        try {
          if (prevDocUri && webviewPanelMap.has(prevDocUri)) {
            const prevPanel = webviewPanelMap.get(prevDocUri);
            if (prevPanel && (prevPanel as any)._steppingActive) {
              // Hard reset stepping state by performing a panel reload
              await performPanelReload(prevPanel);
            }
          }
        } catch { }
      } catch { }
    }
    updateP5Context(editor);
    updateJsOrTsContext(editor);
    if (!editor || !_kidsModeTemporarilyDisabled) {
      updateBlocklyAvailability(editor);
    }
    if (!editor) return;
    if (_kidsModeTemporarilyDisabled) {
      _kidsModeTemporarilyDisabled = false;
    }
    syncTriggersForEditor(editor);
    const docUri = editor.document.uri.toString();
    // Restore focus for P5 panel and set hasP5Webview context per sketch
    const panel = webviewPanelMap.get(docUri);
    if (panel) {
      panel.reveal(panel.viewColumn, true);
      activeP5Panel = panel;
      vscode.commands.executeCommand('setContext', 'hasP5Webview', true);
      updateTriggersPanel();
    } else {
      // No webpanel for this sketch: show Open P5 button
      vscode.commands.executeCommand('setContext', 'hasP5Webview', false);
      updateTriggersPanel();
    }
    // Restore focus for Blockly panel if it exists
    try {
      if (blocklyApi && typeof blocklyApi === 'object') {
        // blocklyPanelForDocument is internal to blocklyPanel.ts, so use API if available
        if (blocklyApi.revealPanelForDocUri) {
          blocklyApi.revealPanelForDocUri(docUri);
        } else if ((blocklyApi as any).focusPanelForDocUri) {
          (blocklyApi as any).focusPanelForDocUri(docUri);
        }
      }
    } catch { /* ignore */ }
    // Ensure active editor is anchored in the top-left group
    try { await layoutService.ensureEditorInLeftColumn(editor); } catch { }
    if (editor && autoReload) autoReload.setupAutoReloadForDoc(editor);
    await maybeActivateKidsMode(editor);
    // Track the last editor for highlight clearing
    _lastStepHighlightEditor = editor;
    // Focus the output channel for the active sketch
  });

  // --- (end handler) ---

  vscode.workspace.onDidChangeTextDocument(e => {
    if (e.document === vscode.window.activeTextEditor?.document) {
      updateP5Context(vscode.window.activeTextEditor);
      updateBlocklyAvailability(vscode.window.activeTextEditor);
      // Stop highlighting as soon as code is changed
      clearStepHighlight(vscode.window.activeTextEditor);
      syncTriggersForEditor(vscode.window.activeTextEditor);
    }

    // Lint on every text change in the script editor
    try {
      // Cheap early-out: if all strict levels are "ignore", skip linting entirely
      const strictKinds: Array<'Semicolon' | 'Undeclared' | 'NoVar' | 'LooseEquality'> = ['Semicolon', 'Undeclared', 'NoVar', 'LooseEquality'];
      const anyEnabled = strictKinds.some(k => lintApi.getStrictLevel(k) !== 'ignore');
      if (!anyEnabled) {
        return;
      }

      lintApi.lintAll(e.document);
    } catch { /* ignore lint errors */ }
  });
  // Sidecar file syncing moved into blockly module
  vscode.workspace.onDidSaveTextDocument(doc => {
    if (doc === vscode.window.activeTextEditor?.document) {
      updateP5Context(vscode.window.activeTextEditor);
      updateBlocklyAvailability(vscode.window.activeTextEditor);
    }
  });
  // Lint when a document is opened/closed
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(doc => {
      try {
        const docUri = doc.uri.toString();
        if (webviewPanelMap.has(docUri)) {
          lintApi.lintAll(doc);
        }
      } catch { /* ignore lint errors */ }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument(async doc => {
      lintApi.clearDiagnosticsForDocument(doc.uri);
      const normalizedClosedPath = (() => {
        try {
          return doc.uri.scheme === 'file' ? panelManager.normalizeFsPath(doc.fileName) : undefined;
        } catch {
          return undefined;
        }
      })();
      const skipPanelDisposal = normalizedClosedPath ? suppressedPanelDisposalPaths.has(normalizedClosedPath) : false;
      // Blockly panels are managed by the blockly module
      // Also close the corresponding P5 panel for this document, if present
      if (!skipPanelDisposal) {
        try {
          const p5Panel = webviewPanelMap.get(doc.uri.toString());
          if (p5Panel) {
            p5Panel.dispose();
          }
        } catch { /* ignore */ }
        // Dispose per-doc output channel as well
        try { disposeOutputForDoc(doc.uri.toString()); } catch { }
        // Deterministic cleanup: close all P5/Blockly panels bound to this exact file path
        try { panelManager.disposePanelsForFilePath(doc.fileName); } catch { /* ignore */ }
      }
    })
  );

  // Also watch tab closures: when the last tab of a script is closed (even if the
  // TextDocument hasn't emitted close yet due to other editors), dispose its panels.
  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs(ev => {
      // Collect candidate file paths from closed tabs
      const candidates = new Set<string>();
      for (const t of ev.closed || []) {
        const fp = panelManager.fsPathFromTab(t);
        if (fp) candidates.add(fp);
      }
      if (!candidates.size) return;
      // Helper: check if any tab remains for a given fsPath
      const anyTabFor = (fsPathNorm: string) => {
        try {
          const groups: readonly vscode.TabGroup[] = (vscode.window.tabGroups as any).all || [vscode.window.tabGroups.activeTabGroup];
          for (const g of groups || []) {
            for (const tab of (g?.tabs || [])) {
              const fp2 = panelManager.fsPathFromTab(tab);
              if (fp2 && fp2 === fsPathNorm) return true;
            }
          }
        } catch { }
        return false;
      };
      for (const p of candidates) {
        if (!anyTabFor(p)) {
          if (suppressedPanelDisposalPaths.has(p)) {
            continue;
          }
          // No more editor tabs for this file: dispose panels
          panelManager.disposePanelsForFilePath(p);
          // Also dispose the associated output channel for this file
          try { disposeOutputForDoc(vscode.Uri.file(p).toString()); } catch { }
        }
      }
    })
  );

  // Auto-reload API instance (initialized after updateDocumentPanel is declared)
  let autoReload: AutoReloadApi;

  // Flag to ignore logs after a syntax error
  let ignoreLogs = false;

  // Update the webview panel with new code, handle syntax errors, and send global variables
  async function updateDocumentPanel(document: vscode.TextDocument, forceLog = false) {
    const docUri = document.uri.toString();
    const panel = webviewPanelMap.get(docUri);
    if (!panel) return;
    const fileName = path.basename(document.fileName);
    const outputChannel = getOrCreateOutputChannel(docUri, fileName);

    // Proactively clear any Blockly block highlight for this document before reloading
    try { blocklyApi.clearHighlight(docUri); } catch { }

    // Capture and clear the pending reason (typing/save/command)
    const reason = _pendingReloadReason;
    _pendingReloadReason = undefined;

    const prep = await prepareSketch({
      document,
      reason: reason as ReloadReason,
      lint: {
        hasSemicolonWarnings: d => lintApi.hasSemicolonWarnings(d),
        hasUndeclaredWarnings: d => lintApi.hasUndeclaredWarnings(d),
        hasVarWarnings: d => lintApi.hasVarWarnings(d),
        hasEqualityWarnings: d => lintApi.hasEqualityWarnings(d),
        getStrictLevel: k => lintApi.getStrictLevel(k),
      },
      allowInteractiveTopInputs: _allowInteractiveTopInputs,
    });

    try {
      const sliderDefs = prep?.globals?.variables
        ? prep.globals.variables.map(g => ({ name: g.name, control: g.control }))
        : [];
      variablesService.setGlobalHintsForDoc(docUri, sliderDefs);
    } catch { }

    let syntaxErrorMsg: string | null = null;

    if (prep.inputsOverlay && prep.inputsOverlay.length > 0) {
      await setHtmlAndPost(panel, {
        code: '',
        extensionPath: context.extensionPath,
        allowInteractiveTopInputs: _allowInteractiveTopInputs,
        initialCaptureVisible: getInitialCaptureVisible(panel),
        p5Version: (panel as any)._p5Version,
      }, [
        { delayMs: 150, message: { type: 'showTopInputs', items: prep.inputsOverlay } as ExtensionToWebviewMessage },
      ], sendToWebview);
      return;
    }

    if (prep.runtimeErrorMsg) {
      const friendly = prep.runtimeErrorMsg;
      await setHtmlAndPost(panel, {
        code: '',
        extensionPath: context.extensionPath,
        allowInteractiveTopInputs: _allowInteractiveTopInputs,
        initialCaptureVisible: getInitialCaptureVisible(panel),
        p5Version: (panel as any)._p5Version,
      }, [
        { delayMs: 150, message: { type: 'showError', message: friendly } as ExtensionToWebviewMessage },
      ], sendToWebview);
      if (cfg.getLogWarningsToOutput()) {
        outputChannel.appendLine(friendly);
      }
      (panel as any)._lastRuntimeError = friendly;
      return;
    }

    if (prep.blockOnLint) {
      if (reason === 'typing') {
        if (forceLog) {
          try { lintApi.logAllWarningsForDocument(document); } catch { }
        }
        return;
      }
      await setHtmlAndPost(panel, {
        code: '',
        extensionPath: context.extensionPath,
        allowInteractiveTopInputs: _allowInteractiveTopInputs,
        initialCaptureVisible: getInitialCaptureVisible(panel),
        p5Version: (panel as any)._p5Version,
      }, [], sendToWebview);
      lintApi.logBlockingWarningsForDocument(document);
      return;
    }

    if (!prep.ok) {
      syntaxErrorMsg = prep.syntaxErrorMsg || null;
      await setHtmlAndPost(panel, {
        code: '',
        extensionPath: context.extensionPath,
        allowInteractiveTopInputs: _allowInteractiveTopInputs,
        initialCaptureVisible: getInitialCaptureVisible(panel),
        p5Version: (panel as any)._p5Version,
      }, [], sendToWebview);
    } else {
      const code = prep.codeToInject;
      _allowInteractiveTopInputs = false;
      try {
        panel.webview.html = await createHtml(code, panel, context.extensionPath, {
          allowInteractiveTopInputs: _allowInteractiveTopInputs,
          initialCaptureVisible: getInitialCaptureVisible(panel),
          p5Version: (panel as any)._p5Version,
        });
      } finally {
        _allowInteractiveTopInputs = true;
      }
      if (prep.globals) {
        setTimeout(() => {
          sendToWebview(panel, {
            type: 'setGlobalVars',
            variables: prep.globals!.variables.map(g => ({ name: g.name, type: g.type, value: undefined })),
            readOnly: prep.globals!.readOnly,
          });
        }, 200);
        setTimeout(() => {
          if (prep.globals && prep.globals.readOnly) {
            try { sendToWebview(panel, { type: 'requestGlobalsSnapshot' }); } catch { }
          }
        }, 600);
      }
    }

    if (syntaxErrorMsg) {
      ignoreLogs = true;
      // Fix [object Arguments] for overlay as well
      const overlayMsg = stripLeadingTimestamp(syntaxErrorMsg).replace(/\[object Arguments\]/gi, "no argument(s) ");
      setTimeout(() => {
        sendToWebview(panel, { type: 'syntaxError', message: overlayMsg });
      }, 150);
      if (cfg.getLogWarningsToOutput()) {
        outputChannel.appendLine(syntaxErrorMsg);
      }
      // outputChannel.show(true); // Do not focus on every error
      (panel as any)._lastSyntaxError = syntaxErrorMsg;
      (panel as any)._lastRuntimeError = null;
    } else {
      ignoreLogs = false;
      (panel as any)._lastSyntaxError = null;
      (panel as any)._lastRuntimeError = null;
    }

    // If requested, log semicolon warnings when the panel reloads (typing/save debounce path)
    if (forceLog) {
      try { lintApi.logAllWarningsForDocument(document); } catch { }
    }
  }

  // Initialize auto-reload module now that updateDocumentPanel exists
  autoReload = registerAutoReload(context, {
    updateDocumentPanel: (doc, log) => updateDocumentPanel(doc, log),
    setPendingReason: (r) => { _pendingReloadReason = r; }
  });
  // Ensure context key is set on activation
  (async () => { try { await autoReload.updateConfig(); } catch { } })();

  // ----------------------------
  // P5 panel command
  // ----------------------------
  registerLiveCommands(context, {
    openLive: async () => {
      if (!hasP5Project) {
        return;
      }
      const kidsDocCandidate = (isKidsModeFeatureEnabled() && activeKidsModeDocUri && kidsModeManagedDocs.has(activeKidsModeDocUri)) ? activeKidsModeDocUri : undefined;
      let editor = vscode.window.activeTextEditor;
      let usedKidsModeFallback = false;
      let cleanupDocUri: string | undefined;
      try {
        if (!editor || (kidsDocCandidate && editor.document.uri.toString() !== kidsDocCandidate)) {
          if (kidsDocCandidate) {
            const doc = await openDocumentSilently(kidsDocCandidate);
            if (!doc) return;
            editor = await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: true, viewColumn: vscode.ViewColumn.Two });
            usedKidsModeFallback = true;
            cleanupDocUri = kidsDocCandidate;
          }
        }
        if (!editor) return;
        const docUri = editor.document.uri.toString();
        cleanupDocUri = cleanupDocUri || docUri;
        let panel = webviewPanelMap.get(docUri);
        let code = editor.document.getText();

        // --- NEW: SingleP5Panel logic ---
        if (isSingleP5PanelEnabled()) {
          // Close all other panels before opening a new one
          for (const [uri, p] of webviewPanelMap.entries()) {
            if (uri !== docUri) {
              p.dispose();
              // The panel.onDidDispose will remove from map
            }
          }
        }

        if (!panel) {
          // Check for syntax errors before setting HTML

          const prep = await prepareSketch({
            document: editor.document,
            reason: 'open',
            lint: {
              hasSemicolonWarnings: d => lintApi.hasSemicolonWarnings(d),
              hasUndeclaredWarnings: d => lintApi.hasUndeclaredWarnings(d),
              hasVarWarnings: d => lintApi.hasVarWarnings(d),
              hasEqualityWarnings: d => lintApi.hasEqualityWarnings(d),
              getStrictLevel: k => lintApi.getStrictLevel(k),
            },
            allowInteractiveTopInputs: _allowInteractiveTopInputs,
          });

          try {
            const sliderDefs = prep?.globals?.variables
              ? prep.globals.variables.map(g => ({ name: g.name, control: g.control }))
              : [];
            variablesService.setGlobalHintsForDoc(docUri, sliderDefs);
          } catch { }

          let syntaxErrorMsg: string | null = prep.syntaxErrorMsg || null;
          const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
          if (!workspaceFolder) return;
          const { localResourceRoots, selectedVersion } = resolveLiveAssets(context, editor);
          // Ensure the originating editor has focus so the new group we create is
          // positioned relative to it.
          const originalColumn = typeof editor.viewColumn === 'number' ? (editor.viewColumn as number) : undefined;
          const previousSuppressState = suppressKidsModeAutoOpen;
          suppressKidsModeAutoOpen = true;
          const previousTempDisable = _kidsModeTemporarilyDisabled;
          _kidsModeTemporarilyDisabled = true;
          const docToUse = editor.document;
          try {
            // Prepare document without forcing it visible; rely on silent document reference.
            await vscode.workspace.openTextDocument(docToUse.uri);
          } catch { /* ignore */ }
          finally {
            suppressKidsModeAutoOpen = previousSuppressState;
            _kidsModeTemporarilyDisabled = previousTempDisable;
          }

          const targetColumn: vscode.ViewColumn = await layoutService.computeTargetColumnForLive();

          panel = panelManager.createPanel(editor, {
            title: livePanelTitleForFile(editor.document.fileName),
            column: targetColumn,
            localResourceRoots,
          });
          syncLocalsHeadingForEditor(editor);
          syncTriggersForEditor(editor);
          try { (panel as any)._p5Version = selectedVersion; } catch { }

          // Focus the output channel for the new sketch immediately
          const fileName = path.basename(editor.document.fileName);
          const outputChannel = getOrCreateOutputChannel(docUri, fileName);
          showAndTrackOutputChannel(outputChannel); // <--- replaced direct show
          // --- LOG ACTIVE p5.js VERSION + WARNINGS via resolver ---
          try { resolveLiveAssets(context, editor, { output: outputChannel, getTime }); } catch { }

          contextService.setCaptureVisible(docUri, false);
          try {
            const drawPresent = detectDrawFunction(editor.document.getText());
            contextService.setHasDraw(docUri, drawPresent);
            contextService.setDrawLoopPaused(docUri, false);
          } catch { }
          try {
            await restore.addToRestore(RESTORE_LIVE_KEY, editor.document.fileName);
            await restore.moveToOrderEnd(editor.document.fileName);
          } catch { }
          activeP5Panel = panel;
          try {
            panel.onDidChangeViewState(() => {
              try {
                if (panel.active) {
                  activeP5Panel = panel;
                  // Keep Variables panel in sync with the newly active webview tab
                  updateVariablesPanel();
                  // Keep TRIGGERS panel in sync with the newly active webview tab
                  updateTriggersPanel();
                }
              } catch { }
            });
          } catch { }
          vscode.commands.executeCommand('setContext', 'hasP5Webview', true);
          // Initialize primed state for this sketch
          contextService.setDebugPrimed(docUri, false);
          panel.onDidDispose(() => {
            try { contextService.setSteppingActive(docUri, false); } catch { }
            contextService.clearForDoc(docUri);
            try { variablesService.clearForDoc(docUri); } catch { }
            try { triggersService.clearForDoc(docUri); } catch { }
            try { disposeOutputForDoc(docUri); } catch { }
            if (activeP5Panel === panel) {
              vscode.commands.executeCommand('setContext', 'p5DebugPrimed', false);
              vscode.commands.executeCommand('setContext', 'p5CaptureVisible', false);
              vscode.commands.executeCommand('setContext', 'p5SteppingActive', false);
              // If the disposed panel was active, refresh Variables panel to reflect no active sketch
              updateVariablesPanel();
              // If the disposed panel was active, refresh TRIGGERS panel to reflect no active sketch
              updateTriggersPanel();
            }
          });

          ; (require('./webview/router') as any).registerWebviewRouter(panel, async (msg: WebviewToExtensionMessage) => {
            if (msg.type === 'setGlobalVars') {
              handleSetGlobalVars({ panel, editor, variables: msg.variables, generatedAt: msg.generatedAt }, {
                setGlobalsForDoc: (docUri, list, opts) => variablesService.setGlobalsForDoc(docUri, list, opts),
                updateVariablesPanel,
                isActivePanel: (p) => activeP5Panel === p,
              });
              return;
            } else if (msg.type === 'revealGlobals') {
              try {
                const docUriStr = editor.document.uri.toString();
                variablesService.revealGlobalsForDoc(docUriStr, typeof msg.count === 'number' ? msg.count : undefined);
              } catch { }
              updateVariablesPanel();
              return;
            } else if (msg.type === 'updateGlobalVar') {
              handleUpdateGlobalVar({ panel, editor, name: msg.name, value: msg.value, generatedAt: msg.generatedAt }, {
                getGlobalsForDoc: (docUri) => variablesService.getGlobalsForDoc(docUri),
                getLocalsForDoc: (docUri) => variablesService.getLocalsForDoc(docUri),
                setGlobalValue: (docUri, name, value, opts) => variablesService.setGlobalValue(docUri, name, value, opts),
                hasGlobalDefinition: (docUri, name) => variablesService.hasGlobalDefinition(docUri, name),
                upsertLocal: (docUri, v) => variablesService.upsertLocalForDoc(docUri, v),
                updateVariablesPanel,
                isActivePanel: (p) => activeP5Panel === p,
              });
              return;
            }
            // Focus the script tab if requested from the webview
            if (msg.type === 'focus-script-tab') {
              handleFocusScriptTab();
              return;
            }
            if (msg.type === 'openLoopGuardSettings') {
              try {
                await vscode.commands.executeCommand('workbench.action.openSettings', 'P5Studio.loopGuard');
              } catch {
                await vscode.commands.executeCommand('workbench.action.openSettings');
              }
              return;
            }
            if (msg.type === 'captureVisibilityChanged') {
              handleCaptureVisibilityChanged({ panel, editor, visible: !!msg.visible }, {
                setCaptureVisible: (docUri, vis) => contextService.setCaptureVisible(docUri, vis),
                setContext: (k, v) => contextService.setContext(k, v),
                isActivePanel: (p) => activeP5Panel === p,
              });
              return;
            }
            const fileName = path.basename(editor.document.fileName);
            const docUri = editor.document.uri.toString();
            // Capture the currently active output channel *before* getOrCreateOutputChannel updates the tracker.
            const lastActiveOutputName = getLastActiveOutputChannel()?.name;
            const outputChannel = getOrCreateOutputChannel(docUri, fileName);
            if (msg.type === 'log') {
              handleLog({ message: msg.message, focus: !!msg.focus }, {
                canLog: () => !ignoreLogs,
                outputChannel,
                getTime,
                focusOutputChannel: () => {
                  // OSC server start intentionally shows the OSC output channel; on the next sketch log,
                  // switch back to the sketch output channel.
                  if (lastActiveOutputName === 'P5 STUDIO: OSC') {
                    showAndTrackOutputChannel(outputChannel);
                  }
                },
              });
            } else if (msg.type === 'loopGuardHit') {
              try {
                const loopCfg = vscode.workspace.getConfiguration('P5Studio');
                const enabled = loopCfg.get<boolean>('loopGuard.enabled', true) !== false;
                const maxIterations = loopCfg.get<number>('loopGuard.maxIterations', 10000);
                const maxTimeMs = loopCfg.get<number>('loopGuard.maxTimeMs', 500);

                const settingsLine = `maxIterations=${maxIterations}, maxTimeMs=${maxTimeMs}`;
                const toast = 'Infinite loop detected, sketch was terminated.\n\r' + settingsLine + '\n\rVS Code can be unresponsive for a few seconds.';
                const action = await vscode.window.showWarningMessage(toast, 'Edit loop guard settings');
                if (action === 'Edit loop guard settings') {
                  try {
                    await vscode.commands.executeCommand('workbench.action.openSettings', 'P5Studio.loopGuard');
                  } catch {
                    await vscode.commands.executeCommand('workbench.action.openSettings');
                  }
                }
              } catch { }
            } else if (msg.type === 'showError') {
              handleShowError({ panel, editor, message: msg.message }, {
                getTime,
                formatSyntaxErrorMsg,
                outputChannel,
              });
            } else if (msg.type === 'submitTopInputs') {
              syncLocalsHeadingForEditor(editor);
              syncTriggersForEditor(editor);
              await handleSubmitTopInputs({ panel, editor, values: msg.values }, {
                detectTopLevelInputs,
                preprocessTopLevelInputs,
                setCachedInputsForKey,
                wrapInSetupIfNeeded,
                extractGlobalVariables,
                extractGlobalVariablesWithConflicts,
                rewriteUserCodeWithWindowGlobals,
                createHtml: (code: string, p: vscode.WebviewPanel, extPath: string, opts?: any) => createHtml(code, p, extPath, { ...(opts || {}), p5Version: (p as any)._p5Version }),
                getInitialCaptureVisible: (p) => getInitialCaptureVisible(p),
                getExtensionPath: () => context.extensionPath,
                getHiddenGlobalsByDirective,
                hasOnlySetup,
                getAllowInteractiveTopInputs: () => _allowInteractiveTopInputs,
                setAllowInteractiveTopInputs: (v: boolean) => { _allowInteractiveTopInputs = v; },
              });
            } else if (msg.type === 'context-menu-refresh') {
              await performPanelReload(panel, { preserveGlobals: false, resetVariablesPanelToCodeInitials: true });
              return;
            } else if (msg.type === 'context-menu-toggle-pause') {
              const docUri = editor.document.uri.toString();
              const hasDraw = contextService?.getHasDraw?.(docUri);
              if (!hasDraw) {
                return;
              }
              const targetPause = !!msg.pause;
              try {
                sendToWebview(panel, { type: targetPause ? 'pauseDrawLoop' : 'resumeDrawLoop' });
              } catch { }
              try { contextService?.setDrawLoopPaused(docUri, targetPause); } catch { }
              return;
            } else if (msg.type === 'context-menu-toggle-capture') {
              await toggleCapture(panel);
              return;
            } else if (msg.type === 'context-menu-toggle-fps') {
              const show = !!(msg as any).show;
              try { await cfg.setShowFPS(show); } catch { }
              try { updateShowFpsContext(show); } catch { }
              try { sendToWebview(panel, { type: 'toggleFPS', show }); } catch { }
              return;
            } else if (msg.type === 'reload-button-clicked') {
              syncLocalsHeadingForEditor(editor);
              syncTriggersForEditor(editor);
              await handleReloadClicked({ panel, editor, preserveGlobals: !!msg.preserveGlobals }, {
                getTime,
                getOrCreateOutputChannel,
                clearStepHighlight,
                blocklyClearHighlight: (docUri: string) => { try { blocklyApi.clearHighlight(docUri); } catch { } },
                lintApi,
                formatSyntaxErrorMsg,
                stripLeadingTimestamp,
                createHtml: (code: string, p: vscode.WebviewPanel, extPath: string, opts?: any) => createHtml(code, p, extPath, { ...(opts || {}), p5Version: (p as any)._p5Version }),
                getInitialCaptureVisible: (p) => getInitialCaptureVisible(p),
                getExtensionPath: () => context.extensionPath,
                validateSource,
                hasNonTopInputUsage,
                detectTopLevelInputs,
                hasCachedInputsForKey,
                preprocessTopLevelInputs,
                getAllowInteractiveTopInputs: () => _allowInteractiveTopInputs,
                setAllowInteractiveTopInputs: (v: boolean) => { _allowInteractiveTopInputs = v; },
                wrapInSetupIfNeeded,
                extractGlobalVariablesWithConflicts,
                extractGlobalVariables,
                rewriteUserCodeWithWindowGlobals,
                getHiddenGlobalsByDirective,
                hasOnlySetup,
                setSteppingActive: (docUri: string, active: boolean) => { try { contextService.setSteppingActive(docUri, active); } catch { } },
                setHasDraw: (docUri: string, value: boolean) => { try { contextService.setHasDraw(docUri, value); } catch { } },
                setDrawLoopPaused: (docUri: string, paused: boolean) => { try { contextService.setDrawLoopPaused(docUri, paused); } catch { } },
                getDrawLoopPaused: (docUri: string) => {
                  try { return contextService.getDrawLoopPaused(docUri); } catch { return false; }
                },
              });
            }
            // --- STEP RUN HANDLER (merged with single-step instrumentation + auto-advance) ---
            else if (msg.type === 'step-run-clicked') {
              try { contextService.setSteppingActive(docUri, true); } catch { }
              syncLocalsHeadingForEditor(editor);
              syncTriggersForEditor(editor);
              await handleStepRunClicked({ panel, editor }, {
                getTime,
                getOrCreateOutputChannel,
                lintApi,
                hasNonTopInputUsage,
                detectTopLevelInputs,
                hasCachedInputsForKey,
                preprocessTopLevelInputs,
                wrapInSetupIfNeeded,
                rewriteFrameCountRefs,
                instrumentSetupForSingleStep,
                extractGlobalVariablesWithConflicts,
                extractGlobalVariables,
                rewriteUserCodeWithWindowGlobals,
                getHiddenGlobalsByDirective,
                hasOnlySetup,
                createHtml: (code: string, p: vscode.WebviewPanel, extPath: string, opts?: any) => createHtml(code, p, extPath, { ...(opts || {}), p5Version: (p as any)._p5Version }),
                getInitialCaptureVisible: (p) => getInitialCaptureVisible(p),
                getExtensionPath: () => context.extensionPath,
                getAllowInteractiveTopInputs: () => _allowInteractiveTopInputs,
                setAllowInteractiveTopInputs: (v: boolean) => { _allowInteractiveTopInputs = v; },
                setSteppingActive: (docUri: string, active: boolean) => { try { contextService.setSteppingActive(docUri, active); } catch { } },
                primeGlobalsForDoc: (docUri, list) => variablesService.primeGlobalsForDoc(docUri, list),
                updateVariablesPanel,
                setHasDraw: (docUri: string, value: boolean) => { try { contextService.setHasDraw(docUri, value); } catch { } },
                setDrawLoopPaused: (docUri: string, paused: boolean) => { try { contextService.setDrawLoopPaused(docUri, paused); } catch { } },
              });
              setTimeout(() => {
                try {
                  if (!(panel as any)._steppingActive) {
                    contextService.setSteppingActive(docUri, false);
                  }
                } catch { }
              }, 400);
            }
            else if (msg.type === 'continue-clicked') {
              try { contextService.setSteppingActive(docUri, true); } catch { }
              await handleContinueClicked({ panel, editor }, {
                getTime,
                getOrCreateOutputChannel,
                setSteppingActive: (doc, value) => { try { contextService.setSteppingActive(doc, value); } catch { } },
              });
              return;
            }
            // --- SINGLE STEP HANDLER ---
            else if (msg.type === 'single-step-clicked') {
              try { contextService.setSteppingActive(docUri, true); } catch { }
              syncLocalsHeadingForEditor(editor);
              syncTriggersForEditor(editor);
              await handleSingleStepClicked({ panel, editor }, {
                getTime,
                getOrCreateOutputChannel,
                lintApi,
                hasNonTopInputUsage,
                detectTopLevelInputs,
                hasCachedInputsForKey,
                preprocessTopLevelInputs,
                wrapInSetupIfNeeded,
                rewriteFrameCountRefs,
                instrumentSetupForSingleStep,
                extractGlobalVariablesWithConflicts,
                extractGlobalVariables,
                rewriteUserCodeWithWindowGlobals,
                getHiddenGlobalsByDirective,
                hasOnlySetup,
                createHtml: (code: string, p: vscode.WebviewPanel, extPath: string, opts?: any) => createHtml(code, p, extPath, { ...(opts || {}), p5Version: (p as any)._p5Version }),
                getInitialCaptureVisible: (p) => getInitialCaptureVisible(p),
                getExtensionPath: () => context.extensionPath,
                setSteppingActive: (docUri: string, active: boolean) => { try { contextService.setSteppingActive(docUri, active); } catch { } },
                primeGlobalsForDoc: (docUri, list) => variablesService.primeGlobalsForDoc(docUri, list),
                updateVariablesPanel,
                setHasDraw: (docUri: string, value: boolean) => { try { contextService.setHasDraw(docUri, value); } catch { } },
                setDrawLoopPaused: (docUri: string, paused: boolean) => { try { contextService.setDrawLoopPaused(docUri, paused); } catch { } },
              });
              setTimeout(() => {
                try {
                  if (!(panel as any)._steppingActive) {
                    contextService.setSteppingActive(docUri, false);
                  }
                } catch { }
              }, 400);
            }
            else if (msg.type === 'startOSC') {
              // Start OSC server, use args if provided (all four override params)
              await startOscServer(
                msg.localAddress,
                msg.localPort,
                msg.remoteAddress,
                msg.remotePort
              );
              return;
            } else if (msg.type === 'stopOSC') {
              await stopOscServer();
              return;
            }
            // --- HIGHLIGHT CURRENT LINE HANDLER ---
            else if (msg.type === 'highlightLine') {
              await handleHighlightLine({ panel, editor, line: msg.line }, {
                getTime,
                getOrCreateOutputChannel,
                applyStepHighlight,
                hasBreakpointOnLine: (docUriStr, line1) => hasBreakpointOnLine(docUriStr, line1),
                blocklyHighlightForLine: (docUri: string, line: number) => { try { blocklyApi.highlightForLine(docUri, line); } catch { } },
              });
            }
            else if (msg.type === 'gotoErrorLine') {
              try {
                const targetLine = Math.max(1, Number(msg.line) || 1);
                const doc = editor.document;
                const focused = await vscode.window.showTextDocument(doc, {
                  preview: false,
                  preserveFocus: false,
                  viewColumn: editor.viewColumn,
                });
                const lineIdx = Math.min(targetLine - 1, Math.max(0, doc.lineCount - 1));
                const lineText = doc.lineAt(lineIdx).text;
                const start = new vscode.Position(lineIdx, 0);
                const end = new vscode.Position(lineIdx, lineText.length);
                const flashRange = new vscode.Range(start, end);
                const redFlashDecoration = vscode.window.createTextEditorDecorationType({
                  isWholeLine: true,
                  backgroundColor: 'rgba(255, 59, 48, 0.30)',
                  overviewRulerColor: 'rgba(255, 59, 48, 0.95)',
                  overviewRulerLane: vscode.OverviewRulerLane.Right,
                });
                focused.selection = new vscode.Selection(start, end);
                focused.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.InCenter);
                focused.setDecorations(redFlashDecoration, [flashRange]);
                const isOn = (sel: vscode.Selection | undefined) => !!sel
                  && sel.start.line === lineIdx
                  && sel.start.character === 0
                  && sel.end.line === lineIdx
                  && sel.end.character === lineText.length;
                const isOff = (sel: vscode.Selection | undefined) => !!sel
                  && sel.start.line === lineIdx
                  && sel.start.character === 0
                  && sel.end.line === lineIdx
                  && sel.end.character === 0;

                let onCount = 1; // initial full-line selection above counts as first flash
                let showing = true;
                const cleanupDecoration = (ed?: vscode.TextEditor) => {
                  try {
                    const target = ed || vscode.window.activeTextEditor;
                    if (target && target.document.uri.toString() === doc.uri.toString()) {
                      target.setDecorations(redFlashDecoration, []);
                    }
                  } catch { }
                  try { redFlashDecoration.dispose(); } catch { }
                };
                const timer = setInterval(() => {
                  try {
                    const active = vscode.window.activeTextEditor;
                    if (!active || active.document.uri.toString() !== doc.uri.toString()) {
                      clearInterval(timer);
                      cleanupDecoration(active);
                      return;
                    }

                    const sel = active.selection;
                    if (!isOn(sel) && !isOff(sel)) {
                      // User changed selection/cursor; stop animation.
                      clearInterval(timer);
                      cleanupDecoration(active);
                      return;
                    }

                    if (showing) {
                      active.selection = new vscode.Selection(start, start);
                      active.setDecorations(redFlashDecoration, []);
                      showing = false;
                    } else {
                      active.selection = new vscode.Selection(start, end);
                      active.setDecorations(redFlashDecoration, [flashRange]);
                      showing = true;
                      onCount += 1;
                      if (onCount >= 3) {
                        clearInterval(timer);
                        setTimeout(() => {
                          try {
                            const finalEd = vscode.window.activeTextEditor;
                            if (!finalEd || finalEd.document.uri.toString() !== doc.uri.toString()) return;
                            const finalSel = finalEd.selection;
                            if (isOn(finalSel) || isOff(finalSel)) {
                              finalEd.selection = new vscode.Selection(start, start);
                            }
                            finalEd.setDecorations(redFlashDecoration, []);
                          } catch { }
                          cleanupDecoration();
                        }, 140);
                      }
                    }
                  } catch {
                    clearInterval(timer);
                    cleanupDecoration();
                  }
                }, 170);
              } catch { }
            }
            // --- CLEAR HIGHLIGHT HANDLER ---
            else if (msg.type === 'clearHighlight') {
              await handleClearHighlight({ panel, editor, final: msg.final }, {
                clearStepHighlight,
                blocklyClearHighlight: (docUri: string) => { try { blocklyApi.clearHighlight(docUri); } catch { } },
                getTime,
                getOrCreateOutputChannel,
                setDebugPrimedFalse: (docUri: string) => { try { contextService.setDebugPrimed(docUri, false); } catch { } },
                setPrimedContextFalse: () => contextService.setContext('p5DebugPrimed', false),
                setSteppingActive: (docUri: string, active: boolean) => { try { contextService.setSteppingActive(docUri, active); } catch { } },
              });
            }
            // --- OSC SEND HANDLER ---
            else if (msg.type === 'oscSend') {
              handleOscSend({ address: msg.address, args: msg.args }, { oscService });
              return;
            }
            // --- SAVE CANVAS IMAGE HANDLER ---
            else if (msg.type === 'saveCanvasImage') {
              await handleSaveCanvasImage({ dataUrl: msg.dataUrl, fileName: msg.fileName }, {
                getDefaultFolder: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
              });
            }
            // --- COPY CANVAS IMAGE HANDLER (fallback when webview clipboard is unavailable) ---
            else if (msg.type === 'copyCanvasImage') {
              handleCopyCanvasImage(msg.dataUrl);
            }
            // --- SHOW INFO MESSAGE FROM WEBVIEW ---
            else if (msg.type === 'showInfo' && typeof msg.message === 'string') {
              handleShowInfo(msg);
            }
          });

          panel.onDidDispose(async () => {
            webviewPanelMap.delete(docUri);
            if (activeP5Panel === panel) activeP5Panel = null;
            vscode.commands.executeCommand('setContext', 'hasP5Webview', false);
            try { autoReload.disposeForDoc(docUri); } catch { }
            try {
              await restore.removeFromRestore(RESTORE_LIVE_KEY, editor.document.fileName);
              await restore.removeFromOrder(editor.document.fileName);
            } catch { }
            // Clear any step highlight when panel is closed
            try {
              const edToClear = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === docUri);
              if (edToClear) clearStepHighlight(edToClear);
            } catch { }
            // Also clear any Blockly block highlight for this document when the P5 panel closes
            try { blocklyApi.clearHighlight(docUri); } catch { }
            (panel as any)._steppingActive = false;
            try { contextService.setSteppingActive(docUri, false); } catch { }
            // Stop auto-step timer if running
            if ((panel as any)._autoStepTimer) {
              try { clearInterval((panel as any)._autoStepTimer); } catch { }
              (panel as any)._autoStepTimer = null;
            }
            (panel as any)._autoStepMode = false;
            // Dispose output channel when panel is closed
            try { (require('./logging/output') as any).disposeOutputForDoc?.(docUri); } catch { }
          });

          panel.onDidChangeViewState(async e => {
            if (e.webviewPanel.active) {
              try {
                const ch = (require('./logging/output') as any).getOutputChannelForDoc?.(docUri);
                if (ch) showAndTrackOutputChannel(ch); // <--- in panel.onDidChangeViewState
              } catch { }
              // Update restore order to reflect recent activation
              try { await restore.moveToOrderEnd(editor.document.fileName); } catch { }
            }
          });

          if (prep.inputsOverlay && prep.inputsOverlay.length > 0) {
            const key = editor.document.fileName;
            let itemsToShow = prep.inputsOverlay;
            if (hasCachedInputsForKey(key, prep.inputsOverlay)) {
              const cached = getCachedInputsForKey(key);
              if (cached) {
                itemsToShow = prep.inputsOverlay.map((it, i) => ({
                  varName: it.varName,
                  label: it.label,
                  defaultValue: typeof cached.values[i] !== 'undefined' ? cached.values[i] : it.defaultValue,
                }));
              }
            }
            await setHtmlAndPost(panel, {
              code: '',
              extensionPath: context.extensionPath,
              allowInteractiveTopInputs: _allowInteractiveTopInputs,
              initialCaptureVisible: getInitialCaptureVisible(panel),
              p5Version: (panel as any)._p5Version,
            }, [
              { delayMs: 150, message: { type: 'showTopInputs', items: itemsToShow } as ExtensionToWebviewMessage },
            ], sendToWebview);
            return;
          }

          if (prep.runtimeErrorMsg) {
            const friendly = prep.runtimeErrorMsg;
            await setHtmlAndPost(panel, {
              code: '',
              extensionPath: context.extensionPath,
              allowInteractiveTopInputs: _allowInteractiveTopInputs,
              initialCaptureVisible: getInitialCaptureVisible(panel),
              p5Version: (panel as any)._p5Version,
            }, [
              { delayMs: 150, message: { type: 'showError', message: friendly } as ExtensionToWebviewMessage },
            ], sendToWebview);
            if (cfg.getLogWarningsToOutput()) {
              outputChannel.appendLine(friendly);
            }
            (panel as any)._lastRuntimeError = friendly;
            (panel as any)._lastSyntaxError = null;
            return;
          }

          if (prep.blockOnLint) {
            await setHtmlAndPost(panel, {
              code: '',
              extensionPath: context.extensionPath,
              allowInteractiveTopInputs: _allowInteractiveTopInputs,
              initialCaptureVisible: getInitialCaptureVisible(panel),
              p5Version: (panel as any)._p5Version,
            }, [], sendToWebview);
            lintApi.logBlockingWarningsForDocument(editor.document);
          } else {
            await setHtmlAndPost(panel, {
              code: prep.ok ? prep.codeToInject : '',
              extensionPath: context.extensionPath,
              allowInteractiveTopInputs: _allowInteractiveTopInputs,
              initialCaptureVisible: getInitialCaptureVisible(panel),
              p5Version: (panel as any)._p5Version,
            }, [], sendToWebview);
            lintApi.logSemicolonWarningsForDocument(editor.document);
            lintApi.logUndeclaredWarningsForDocument(editor.document);
            lintApi.logVarWarningsForDocument(editor.document);
          }

          if (prep.globals && prep.ok && !prep.blockOnLint) {
            const varsPayload = prep.globals.variables.map(g => ({ name: g.name, type: g.type, value: undefined }));
            setTimeout(() => {
              sendToWebview(panel, { type: 'setGlobalVars', variables: varsPayload, readOnly: prep.globals!.readOnly });
            }, 200);
          }

          if (syntaxErrorMsg) {
            setTimeout(() => {
              sendToWebview(panel, { type: 'syntaxError', message: stripLeadingTimestamp(syntaxErrorMsg) });
            }, 150);
            const outputChannel = getOrCreateOutputChannel(docUri, path.basename(editor.document.fileName));
            if (cfg.getLogWarningsToOutput()) {
              outputChannel.appendLine(syntaxErrorMsg);
            }
          }
        } else {
          try {
            const drawPresent = detectDrawFunction(editor.document.getText());
            contextService.setHasDraw(docUri, drawPresent);
            contextService.setDrawLoopPaused(docUri, false);
          } catch { }
          panel.reveal(panel.viewColumn, true);
          setTimeout(() => {
            let codeToSend = editor.document.getText();
            // --- Check for syntax/reference errors BEFORE wrapping in setup ---
            try {
              new Function(codeToSend);
              codeToSend = wrapInSetupIfNeeded(instrumentRuntimeLineTracking(codeToSend));
              try {
                codeToSend = injectLoopGuards(codeToSend, { tagPrefix: path.basename(editor.document.fileName) }).code;
              } catch { /* ignore guard errors */ }
              // Optionally block on semicolon warnings
              const warnSemi_RO = lintApi.hasSemicolonWarnings(editor.document);
              const warnUnd_RO = lintApi.hasUndeclaredWarnings(editor.document);
              const warnVar_RO = lintApi.hasVarWarnings(editor.document);
              const shouldBlockRO = (lintApi.getStrictLevel('Semicolon') === 'block' && warnSemi_RO.has)
                || (lintApi.getStrictLevel('Undeclared') === 'block' && warnUnd_RO.has)
                || (lintApi.getStrictLevel('NoVar') === 'block' && warnVar_RO.has);
              if (shouldBlockRO) {
                (async () => {
                  panel.webview.html = await createHtml('', panel, context.extensionPath, { p5Version: (panel as any)._p5Version });
                  lintApi.logBlockingWarningsForDocument(editor.document);
                })();
              } else {
                sendToWebview(panel, { type: 'reload', code: codeToSend });
                // Log warnings on explicit open -> reload path
                lintApi.logSemicolonWarningsForDocument(editor.document);
                lintApi.logUndeclaredWarningsForDocument(editor.document);
                lintApi.logVarWarningsForDocument(editor.document);
              }
            } catch (err: any) {
              // If error, send empty code and show error
              sendToWebview(panel, { type: 'reload', code: '' });
              const syntaxErrorMsg = `${getTime()} [‼️SYNTAX ERROR in ${path.basename(editor.document.fileName)}] ${err.message}`;
              sendToWebview(panel, { type: 'syntaxError', message: stripLeadingTimestamp(formatSyntaxErrorMsg(syntaxErrorMsg)) });
              const outputChannel = getOrCreateOutputChannel(docUri, path.basename(editor.document.fileName));
              if (cfg.getLogWarningsToOutput()) {
                outputChannel.appendLine(formatSyntaxErrorMsg(syntaxErrorMsg));
              }
            }
          }, 100);
        }

        updateP5Context(editor);
        if (editor && autoReload) autoReload.setupAutoReloadForDoc(editor);
      } finally {
        if (usedKidsModeFallback && cleanupDocUri) {
          try { await closeEditorTabForDoc(cleanupDocUri); } catch { }
        }
      }
    }
  });

  // Command to reload the current P5 sketch
  context.subscriptions.push(
    vscode.commands.registerCommand('extension.reload-p5-sketch', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        // Try to reload the currently active webview panel's sketch if no editor is focused
        if (activeP5Panel) {
          // Find the document URI for the active panel
          const docUri = [...webviewPanelMap.entries()].find(([_, panel]) => panel === activeP5Panel)?.[0];
          if (docUri) {
            const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === docUri);
            if (doc) {
              resetDebugStateForDoc(docUri);
              // Log all warnings on explicit reload command
              lintApi.logAllWarningsForDocument(doc);
              _pendingReloadReason = 'command';
              autoReload.debounceUpdate(doc, false);
            }
          }
        }
        return;
      }
      resetDebugStateForDoc(editor.document.uri.toString());
      // Log all warnings on explicit reload command
      lintApi.logAllWarningsForDocument(editor.document);
      _pendingReloadReason = 'command';
      autoReload.debounceUpdate(editor.document, false); // use false to match typing
    })
  );

  // Command to disable reload while typing
  context.subscriptions.push(
    vscode.commands.registerCommand('P5Studio.toggleReloadWhileTypingOn', async () => {
      await cfg.setReloadWhileTyping(false);
      await autoReload.updateConfig();
      autoReload.refreshAll();
      vscode.window.showInformationMessage('Reload on typing is now disabled.');
    })
  );
  // Command to enable reload while typing
  context.subscriptions.push(
    vscode.commands.registerCommand('P5Studio.toggleReloadWhileTypingOff', async () => {
      await cfg.setReloadWhileTyping(true);
      await autoReload.updateConfig();
      autoReload.refreshAll();
      vscode.window.showInformationMessage('Reload on typing is now enabled.');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('P5Studio.enableShowFPS', async () => {
      try {
        await cfg.setShowFPS(true);
        updateShowFpsContext(true);
      } catch (err) {
        console.error('[P5Studio] Failed enabling FPS overlay', err);
        vscode.window.showErrorMessage('Failed to enable the FPS overlay.');
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('P5Studio.disableShowFPS', async () => {
      try {
        await cfg.setShowFPS(false);
        updateShowFpsContext(false);
      } catch (err) {
        console.error('[P5Studio] Failed disabling FPS overlay', err);
        vscode.window.showErrorMessage('Failed to disable the FPS overlay.');
      }
    })
  );
  // Command to open selected text in the P5 reference
  context.subscriptions.push(
    vscode.commands.registerCommand('extension.openSelectedText', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }

      let text: string | undefined;

      if (editor.selection && !editor.selection.isEmpty) {
        text = editor.document.getText(editor.selection);
      } else {
        const pos = editor.selection.active;
        const wordRange = editor.document.getWordRangeAtPosition(pos);
        if (wordRange) {
          text = editor.document.getText(wordRange);
        }
      }

      if (!text || !text.trim()) {
        // No word/selection: just open the main P5 reference
        vscode.commands.executeCommand('extension.openP5Ref');
        return;
      }

      const search = encodeURIComponent(text.trim());
      try {
        const version = cfg.getP5jsVersion();
        const base = (version === '2.1') ? 'https://beta.p5js.org/reference/' : 'https://p5js.org/reference/';
        vscode.env.openExternal(vscode.Uri.parse(`${base}p5/${search}`));
      } catch {
        vscode.env.openExternal(vscode.Uri.parse(`https://p5js.org/reference/p5/${search}`));
      }
    })
  );

  // Commands to zoom editor font and persist via P5Studio.editorFontSize
  context.subscriptions.push(
    vscode.commands.registerCommand('P5Studio.fontZoomIn', async () => {
      const editorCfg = vscode.workspace.getConfiguration('editor');
      const current = editorCfg.get<number>('fontSize', 14);
      const next = current + 1;
      try {
        await editorCfg.update('fontSize', next, vscode.ConfigurationTarget.Global);
        await cfg.setEditorFontSize(next);
      } catch { }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('P5Studio.fontZoomOut', async () => {
      const editorCfg = vscode.workspace.getConfiguration('editor');
      const current = editorCfg.get<number>('fontSize', 14);
      const next = Math.max(6, current - 1);
      try {
        await editorCfg.update('fontSize', next, vscode.ConfigurationTarget.Global);
        await cfg.setEditorFontSize(next);
      } catch { }
    })
  );

  // Command to create jsconfig.json and setup a new P5 project
  context.subscriptions.push(
    vscode.commands.registerCommand('extension.create-jsconfig', async () => {
      let workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      let selectedFolderUri: vscode.Uri | undefined;
      if (!workspaceFolder) {
        const folderUris = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          openLabel: 'Select folder for new P5 project',
        });
        if (!folderUris || folderUris.length === 0) {
          return;
        }
        selectedFolderUri = folderUris[0];
        workspaceFolder = { uri: selectedFolderUri, name: path.basename(selectedFolderUri.fsPath), index: 0 };
      }

      if (!workspaceFolder) {
        return;
      }

      const rootPath = workspaceFolder.uri.fsPath;
      const pathExists = async (target: string) => {
        try {
          await fsp.access(target, fs.constants.F_OK);
          return true;
        } catch {
          return false;
        }
      };

      const ensureWritableMarker = async (target: string) => {
        try {
          const stat = await fsp.lstat(target);
          if (stat.isDirectory()) {
            const contents = await fsp.readdir(target);
            if (contents.length > 0) {
              throw new Error(`A folder named '.p5' already exists at ${target}. Remove or rename it and try again.`);
            }
            await fsp.rmdir(target);
            return;
          }
          await fsp.chmod(target, 0o666).catch(() => { /* ignore */ });
          await fsp.unlink(target);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException)?.code;
          if (code === 'ENOENT') {
            return;
          }
          if (code === 'EPERM') {
            try {
              await fsp.chmod(target, 0o666);
            } catch { /* ignore chmod errors */ }
            try {
              await fsp.unlink(target);
              return;
            } catch (unlinkErr) {
              throw unlinkErr;
            }
          }
          if (err instanceof Error) {
            throw err;
          }
          throw new Error(String(err));
        }
      };

      let sketch1Path: string | undefined;
      let sketchCreated = false;

      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'Setting up new P5 project...',
            cancellable: false,
          },
          async (progress) => {
            progress.report({ message: 'Preparing folders' });
            const commonDir = path.join(rootPath, 'common');
            const importDir = path.join(rootPath, 'import');
            const mediaDir = path.join(rootPath, 'media');
            const sketchesDir = path.join(rootPath, 'sketches');
            await Promise.all([
              fsp.mkdir(commonDir, { recursive: true }),
              fsp.mkdir(importDir, { recursive: true }),
              fsp.mkdir(mediaDir, { recursive: true }),
              fsp.mkdir(sketchesDir, { recursive: true }),
            ]);

            progress.report({ message: 'Seeding helper files' });

            // Copy extension's common/ and import/ files into the new project
            const extCommon = path.join(context.extensionPath, 'common');
            const extImport = path.join(context.extensionPath, 'import');
            async function copyDir(src: string, dest: string) {
              if (!fs.existsSync(src)) return;
              for (const entry of fs.readdirSync(src)) {
                const srcPath = path.join(src, entry);
                const destPath = path.join(dest, entry);
                if (fs.statSync(srcPath).isDirectory()) {
                  await fsp.mkdir(destPath, { recursive: true });
                  await copyDir(srcPath, destPath);
                } else {
                  await fsp.copyFile(srcPath, destPath);
                }
              }
            }
            await copyDir(extCommon, commonDir);
            await copyDir(extImport, importDir);

            sketch1Path = path.join(sketchesDir, 'sketch1.js');
            const sketchExists = await pathExists(sketch1Path);
            if (!sketchExists) {
              sketchCreated = true;
              const sketchLines = [
                '// Start coding with P5 here!',
                '// Have a look at the P5 Reference: https://p5js.org/reference/',
                '// Click the P5 button at the top to run your sketch! ⤴',
                '',
                'noStroke();',
                'fill("red");',
                'circle(50, 50, 80);',
                'fill("white");',
                'textFont("Arial", 36);',
                'textAlign(CENTER, CENTER);',
                'text("P5", 50, 52);',
                '',
              ];
              await fsp.writeFile(sketch1Path, sketchLines.join('\n'), 'utf8');
            }

            progress.report({ message: 'Writing configuration' });
            const now = new Date();
            const selectedVersion = cfg.getP5jsVersion();
            const versionDir = selectedVersion === '1.11' ? '1.11' : selectedVersion;
            const p5typesRoot = path.join(context.extensionPath, 'assets', versionDir, 'p5types');
            const globalDts = path.join(p5typesRoot, 'global.d.ts');
            const helperDts = path.join(p5typesRoot, 'p5helper.d.ts');
            const include: string[] = [
              "sketches/**/*.js",
              "include/**/*.js",
              "import/**/*.js",
              "common/**/*.js",
              "include/**/*d.ts",
              "import/**/*.d.ts",
              "common/**/*.d.ts",
            ];
            const hasGlobal = await pathExists(globalDts);
            const hasHelper = await pathExists(helperDts);
            if (hasGlobal) include.push(globalDts);
            if (hasHelper) include.push(helperDts);
            const jsconfig = {
              createdAt: toLocalISOString(now),
              projectType: 'p5js',
              include,
            };
            await fsp.writeFile(path.join(rootPath, 'jsconfig.json'), JSON.stringify(jsconfig, null, 2), 'utf8');

            if (selectedVersion !== '1.11' && (!hasGlobal || !hasHelper)) {
              console.warn('[P5Studio] No p5types found for version', selectedVersion, '- jsconfig will omit type definitions.');
            }

            // (No longer create .p5 marker file)
          }
        );

        vscode.window.showInformationMessage('P5 project setup complete!');

        if (selectedFolderUri) {
          await vscode.commands.executeCommand('vscode.openFolder', selectedFolderUri, false);
        } else if (sketchCreated && sketch1Path) {
          const doc = await vscode.workspace.openTextDocument(sketch1Path);
          await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false, viewColumn: vscode.ViewColumn.One });
        }
      } catch (e) {
        console.error(e);
        vscode.window.showErrorMessage(`Failed to setup P5 project: ${e instanceof Error ? e.message : String(e)}`);
      }
    })
  );

  // Simple debouncers for config-driven broadcasts
  let _varPanelDebounceTimer: NodeJS.Timeout | undefined;
  let _showFpsDebounceTimer: NodeJS.Timeout | undefined;
  let _overlayFontDebounceTimer: NodeJS.Timeout | undefined;

  const restartTsServer = () => {
    void vscode.commands.executeCommand('typescript.restartTsServer').then(undefined, () => { });
  };

  // Centralized configuration change handler
  vscode.workspace.onDidChangeConfiguration(e => {
    try {
      // OSC config changes
      try { oscService?.handleConfigChange(e); } catch { }

      // Debounce delay for auto-reload
      if (e.affectsConfiguration('P5Studio.debounceDelay')) {
        try { autoReload.clearDebounceCache(); } catch { }
      }

      // Variable panel debounce delay (debounced broadcast)
      if (e.affectsConfiguration('P5Studio.variablePanelDebounceDelay')) {
        const newDelay = cfg.getVariablePanelDebounceDelay();
        if (_varPanelDebounceTimer) clearTimeout(_varPanelDebounceTimer);
        _varPanelDebounceTimer = setTimeout(() => {
          for (const [, panel] of webviewPanelMap.entries()) {
            try { sendToWebview(panel, { type: 'updateVarDebounceDelay', value: newDelay }); } catch { }
          }
        }, 150);
      }

      if (e.affectsConfiguration('P5Studio.P5jsVersion')) {
        (async () => {
          try {
            const livePanels = Array.from(webviewPanelMap.values());
            for (const panel of livePanels) {
              try { panel.dispose(); } catch { }
            }
            try { blocklyApi.disposeAllPanels?.(); } catch { }
            await refreshJsconfigIfMarkerPresent(context);
          } catch { /* ignore refresh errors */ }
          restartTsServer();
          const version = cfg.getP5jsVersion();
          vscode.window.showInformationMessage(`Switched to version ${version}: Closed any open panels`);
        })();
      }

      // Sync reloadWhileTyping/reloadOnSave when changed via settings UI
      if (e.affectsConfiguration('P5Studio.reloadWhileTyping') || e.affectsConfiguration('P5Studio.reloadOnSave')) {
        (async () => { try { await autoReload.updateConfig(); } catch { } })();
        autoReload.refreshAll();
      }

      // Immediately apply showFPS changes in all open panels (debounced)
      if (e.affectsConfiguration('P5Studio.showFPS')) {
        const show = cfg.getShowFPS();
        updateShowFpsContext(show);
        if (_showFpsDebounceTimer) clearTimeout(_showFpsDebounceTimer);
        _showFpsDebounceTimer = setTimeout(() => {
          for (const [, panel] of webviewPanelMap.entries()) {
            try { sendToWebview(panel, { type: 'toggleFPS', show }); } catch { }
          }
        }, 100);
      }

      if (e.affectsConfiguration('P5Studio.blockly.kidsMode') || e.affectsConfiguration('P5Studio.blockly.enableBlockly')) {
        kidsModeEnabled = cfg.getBlocklyKidsMode();
        blocklyFeatureEnabled = cfg.getBlocklyEnabled();
        (async () => {
          if (!isKidsModeFeatureEnabled()) {
            kidsModeManagedDocs.clear();
            kidsModeInFlightDocs.clear();
            activeKidsModeDocUri = null;
            await vscode.commands.executeCommand('setContext', 'p5BlocklyKidsModeActive', false);
            if (!vscode.window.activeTextEditor) {
              await vscode.commands.executeCommand('setContext', 'hasP5Webview', false);
            }
            return;
          }
          if (activeKidsModeDocUri) {
            await updateKidsModeToolbarContext(activeKidsModeDocUri, true);
          }
        })();
      }

      // Update overlay font size if the editor font size changes (debounced)
      if (e.affectsConfiguration('editor.fontSize')) {
        const newSize = vscode.workspace.getConfiguration('editor').get<number>('fontSize', 14);
        try { cfg.setEditorFontSize(newSize); } catch { }
        if (_overlayFontDebounceTimer) clearTimeout(_overlayFontDebounceTimer);
        _overlayFontDebounceTimer = setTimeout(() => {
          for (const [, panel] of webviewPanelMap.entries()) {
            try { sendToWebview(panel, { type: 'updateOverlayFontSize', value: newSize }); } catch { }
          }
        }, 100);
      }
    } catch {
      // ignore config handler errors
    }
  });

  // Project setup utilities (refresh jsconfig, setup prompt)
  runOnActivate(context);

  // Gently restart the TS server so new jsconfig/p5 types register without user action
  restartTsServer();

  // Helper: compute Blockly sidecar path for a given file path
  function getBlocklySidecarPath(filePath: string): string | null {
    try {
      const dir = path.dirname(filePath);
      const base = path.basename(filePath);
      const sidecarDir = path.join(dir, '.blockly');
      const sidecarName = base + '.blockly';
      return path.join(sidecarDir, sidecarName);
    } catch {
      return null;
    }
  }

  // --- NEW: Scroll P5 output to end command ---
  context.subscriptions.push(
    vscode.commands.registerCommand('P5Studio.scrollOutputToEnd', async () => {
      const lastActiveOutputChannel = getLastActiveOutputChannel();
      if (!lastActiveOutputChannel) {
        vscode.window.showInformationMessage('No P5 STUDIO output channel active.');
        return;
      }
      showAndTrackOutputChannel(lastActiveOutputChannel);
      setTimeout(() => vscode.commands.executeCommand('cursorBottom'), 30);
    })
  );

  // Export a JS sketch as standalone HTML with inline p5 code
  context.subscriptions.push(
    vscode.commands.registerCommand('extension.publishP5Html', async (resource?: vscode.Uri, ...args: any[]) => {
      try {
        const pickUriFromArg = (value: any): vscode.Uri | undefined => {
          if (!value) return undefined;
          if (value instanceof vscode.Uri) return value;
          if (Array.isArray(value)) {
            for (const item of value) {
              const uri = pickUriFromArg(item);
              if (uri) return uri;
            }
            return undefined;
          }
          if (typeof value === 'object') {
            const maybePath = (value as any).fsPath;
            if (typeof maybePath === 'string' && maybePath.length > 0) {
              try { return vscode.Uri.file(maybePath); } catch { return undefined; }
            }
          }
          return undefined;
        };

        let fileUri = pickUriFromArg(resource) || pickUriFromArg(args);

        if (!fileUri) {
          const activeUri = vscode.window.activeTextEditor?.document.uri;
          if (activeUri && activeUri.scheme === 'file') {
            fileUri = activeUri;
          }
        }

        if (!fileUri) {
          const picked = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters: { 'JavaScript Files': ['js'] },
            openLabel: 'Select p5 sketch',
          });
          if (!picked || picked.length === 0) return;
          fileUri = picked[0];
        }

        if (path.extname(fileUri.fsPath).toLowerCase() !== '.js') {
          vscode.window.showErrorMessage('Publish P5 HTML only supports .js files.');
          return;
        }

        const sourceBytes = await vscode.workspace.fs.readFile(fileUri);
        const sketchCode = Buffer.from(sourceBytes).toString('utf8');
        const escapedSketchCode = sketchCode.replace(/<\/script/gi, '<\\/script');

        const sketchDir = path.dirname(fileUri.fsPath);
        const sketchBase = path.basename(fileUri.fsPath, path.extname(fileUri.fsPath));
        const defaultOutput = vscode.Uri.file(path.join(sketchDir, `${sketchBase}.html`));

        const saveUri = await vscode.window.showSaveDialog({
          defaultUri: defaultOutput,
          filters: { 'HTML Files': ['html', 'htm'] },
          saveLabel: 'Publish P5 HTML',
          title: 'Publish P5 HTML',
        });
        if (!saveUri) return;

        const html = [
          '<!DOCTYPE html>',
          '<html lang="en">',
          '<head>',
          '  <meta charset="UTF-8" />',
          '  <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
          `  <title>${sketchBase}</title>`,
          '  <style>',
          '    html, body {',
          '      margin: 0;',
          '      padding: 0;',
          '      min-height: 100%;',
          '      background: #f5f5f5;',
          '    }',
          '    canvas {',
          '      display: block;',
          '    }',
          '  </style>',
          '  <script src="https://cdn.jsdelivr.net/npm/p5@1.11.11/lib/p5.min.js"></script>',
          '</head>',
          '<body>',
          '  <script>',
          escapedSketchCode,
          '  </script>',
          '</body>',
          '</html>',
          '',
        ].join('\n');

        await vscode.workspace.fs.writeFile(saveUri, Buffer.from(html, 'utf8'));
        vscode.window.showInformationMessage(`Published P5 HTML: ${path.basename(saveUri.fsPath)}`);
      } catch (e: any) {
        vscode.window.showErrorMessage('Failed to publish P5 HTML: ' + (e?.message || String(e)));
      }
    })
  );

  // --- Duplicate file command for explorer context menu ---
  context.subscriptions.push(
    vscode.commands.registerCommand('extension.duplicateFile', async (fileUri: vscode.Uri) => {
      try {
        // If not invoked from context menu, prompt for file
        if (!fileUri) {
          const picked = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            openLabel: 'Select file to duplicate',
          });
          if (!picked || picked.length === 0) return;
          fileUri = picked[0];
        }
        const oldPath = fileUri.fsPath;
        const dir = path.dirname(oldPath);
        const base = path.basename(oldPath);
        const ext = path.extname(base);
        const nameNoExt = base.slice(0, base.length - ext.length);

        // If filename ends with a number, increment it
        let match = nameNoExt.match(/^(.*?)(\d+)$/);
        let newBase: string;
        if (match) {
          const prefix = match[1];
          const num = parseInt(match[2], 10);
          let nextNum = num + 1;
          let candidate = `${prefix}${nextNum}${ext}`;
          // Find next available number
          while (fs.existsSync(path.join(dir, candidate))) {
            nextNum++;
            candidate = `${prefix}${nextNum}${ext}`;
          }
          newBase = candidate;
        } else {
          // Fallback: filename, filename-2, filename-3, etc.
          let candidate = `${nameNoExt}${ext}`;
          let counter = 1;
          while (fs.existsSync(path.join(dir, candidate))) {
            candidate = `${nameNoExt}-${counter}${ext}`;
            counter++;
          }
          newBase = candidate;
        }

        const newName = await vscode.window.showInputBox({
          prompt: 'Duplicate file as...',
          value: newBase,
          validateInput: (val) => {
            if (!val || val.trim() === '') return 'File name required';
            if (fs.existsSync(path.join(dir, val))) return 'File already exists';
            return null;
          }
        });
        if (!newName) return;
        const newPath = path.join(dir, newName);
        await vscode.workspace.fs.copy(fileUri, vscode.Uri.file(newPath));
        // If a sidecar exists for the source file, copy it for the duplicate
        try {
          const srcSide = getBlocklySidecarPath(fileUri.fsPath);
          if (srcSide && fs.existsSync(srcSide)) {
            const destSide = getBlocklySidecarPath(newPath);
            if (destSide) {
              fs.mkdirSync(path.dirname(destSide), { recursive: true });
              fs.copyFileSync(srcSide, destSide);
            }
          }
        } catch (e) { /* ignore */ }
        // Optionally open the new file
        const doc = await vscode.workspace.openTextDocument(newPath);
        await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false, viewColumn: vscode.ViewColumn.One });
      } catch (e: any) {
        vscode.window.showErrorMessage('Failed to duplicate file: ' + (e.message || e));
      }
    })
  );

  // Best-effort: when files are created via external copy/paste operations, try to
  // detect if they are duplicates of an existing file and copy its sidecar.
  // We do this by computing a content hash for the created file and comparing it
  // with candidate workspace files (limited to common script extensions) to find
  // an exact match. If found, copy the matching file's sidecar.
  context.subscriptions.push(vscode.workspace.onDidCreateFiles(async ev => {
    try {
      for (const created of ev.files) {
        const createdFs = created.fsPath;
        let createdBuffer: Buffer | null = null;
        try { createdBuffer = fs.readFileSync(createdFs); } catch { createdBuffer = null; }
        if (!createdBuffer) continue;
        const hash = crypto.createHash('sha1').update(createdBuffer).digest('hex');
        // Search workspace for candidate script files (js/ts/jsx/tsx)
        const patterns = ['**/*.js', '**/*.ts', '**/*.jsx', '**/*.tsx'];
        let candidates: vscode.Uri[] = [];
        for (const p of patterns) {
          try {
            const found = await vscode.workspace.findFiles(p, '**/.blockly/**', 200);
            candidates = candidates.concat(found);
          } catch { }
        }
        // Compare hashes with candidates
        for (const cand of candidates) {
          try {
            const candFs = cand.fsPath;
            if (candFs === createdFs) continue;
            const candBuffer = fs.readFileSync(candFs);
            const candHash = crypto.createHash('sha1').update(candBuffer).digest('hex');
            if (candHash === hash) {
              const srcSide = getBlocklySidecarPath(candFs);
              const destSide = getBlocklySidecarPath(createdFs);
              if (srcSide && fs.existsSync(srcSide) && destSide) {
                try {
                  fs.mkdirSync(path.dirname(destSide), { recursive: true });
                  fs.copyFileSync(srcSide, destSide);
                } catch { }
              }
              break; // done for this created file
            }
          } catch { }
        }
      }
    } catch (e) { }
  }));
}

// Helper to check SingleP5Panel setting
function isSingleP5PanelEnabled() {
  return cfg.getSingleP5Panel();
}

