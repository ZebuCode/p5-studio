import * as vscode from 'vscode';
import { config as cfg } from '../../config';
import { buildStepMap, StepMap } from '../../processing/stepMap';
import { findFirstTemplateLiteral, formatTemplateLiteralError } from '../../processing/astHelpers';
import { detectDrawFunction } from '../../utils/helpers';
import type { VarControl } from '../../types';

function findFirstExecutableLine(code: string): number | null {
  try {
    const acorn = require('acorn');
    const ast = acorn.parse(code, { ecmaVersion: 2020, sourceType: 'script', locations: true });
    const body: any[] = Array.isArray((ast as any).body) ? (ast as any).body : [];
    for (const stmt of body) {
      if (!stmt || !stmt.loc) continue;
      switch (stmt.type) {
        case 'EmptyStatement':
        case 'VariableDeclaration':
        case 'FunctionDeclaration':
        case 'ClassDeclaration':
        case 'ImportDeclaration':
        case 'ExportNamedDeclaration':
        case 'ExportDefaultDeclaration':
        case 'ExportAllDeclaration':
          continue;
        default: {
          if (stmt.type === 'ExpressionStatement' && stmt.expression && stmt.expression.type === 'Literal') {
            // Skip directive prologues such as 'use strict'.
            continue;
          }
          return stmt.loc.start ? stmt.loc.start.line : null;
        }
      }
    }
  } catch {
    // ignore parse failures and fall back to default offset
  }
  return null;
}

function computeLineOffset(rawCode: string, wrappedCode: string, didWrap: boolean): number {
  if (!didWrap) return 0;
  try {
    const firstExecutable = findFirstExecutableLine(rawCode);
    const stepMap = buildStepMap(wrappedCode);
    const firstSetupStep = stepMap.steps.find(s => s.phase === 'setup');
    if (typeof firstExecutable === 'number' && firstSetupStep && typeof firstSetupStep.loc?.line === 'number') {
      return firstSetupStep.loc.line - firstExecutable;
    }
  } catch {
    // fall back below
  }
  return 1;
}

export async function handleStepRunClicked(
  params: { panel: vscode.WebviewPanel; editor: vscode.TextEditor },
  deps: {
    getTime: () => string;
    getOrCreateOutputChannel: (docUri: string, fileName: string) => vscode.OutputChannel;
    lintApi: {
      logSemicolonWarningsForDocument: (doc: vscode.TextDocument) => void;
      logUndeclaredWarningsForDocument: (doc: vscode.TextDocument) => void;
      logVarWarningsForDocument: (doc: vscode.TextDocument) => void;
      logEqualityWarningsForDocument: (doc: vscode.TextDocument) => void;
      hasSemicolonWarnings: (doc: vscode.TextDocument) => { has: boolean };
      hasUndeclaredWarnings: (doc: vscode.TextDocument) => { has: boolean };
      hasVarWarnings: (doc: vscode.TextDocument) => { has: boolean };
      hasEqualityWarnings: (doc: vscode.TextDocument) => { has: boolean };
      getStrictLevel: (rule: 'Semicolon' | 'Undeclared' | 'NoVar' | 'LooseEquality') => 'warn' | 'block' | 'ignore';
      logBlockingWarningsForDocument: (doc: vscode.TextDocument) => void;
    };
    hasNonTopInputUsage: (code: string) => boolean;
    detectTopLevelInputs: (code: string) => Array<{ varName: string; label?: string; defaultValue?: any }>;
    hasCachedInputsForKey: (key: string, items: Array<{ varName: string; label?: string }>) => boolean;
    preprocessTopLevelInputs: (code: string, opts: { key: string; interactive: boolean }) => Promise<string>;
    wrapInSetupIfNeeded: (code: string) => string;
    rewriteFrameCountRefs: (code: string) => string;
    instrumentSetupForSingleStep: (code: string, lineOffset: number, opts?: { disableTopLevelPreSteps?: boolean; docStepMap?: StepMap; topLevelGlobals?: string[] }) => string;
    extractGlobalVariablesWithConflicts: (code: string) => { globals: Array<{ name: string; value: any; type: string; control?: VarControl; readonly?: boolean }>; conflicts: string[] };
    extractGlobalVariables: (code: string) => Array<{ name: string; value: any; type: string; control?: VarControl; readonly?: boolean }>;
    rewriteUserCodeWithWindowGlobals: (code: string, globals: Array<{ name: string; value?: any; control?: VarControl; readonly?: boolean }>) => string;
    getHiddenGlobalsByDirective: (code: string) => Set<string>;
    hasOnlySetup: (code: string) => boolean;
    createHtml: (code: string, panel: vscode.WebviewPanel, extensionPath: string, opts?: { allowInteractiveTopInputs?: boolean; initialCaptureVisible?: boolean }) => Promise<string>;
    getInitialCaptureVisible: (panel: vscode.WebviewPanel) => boolean;
    getExtensionPath: () => string;
    getAllowInteractiveTopInputs: () => boolean;
    setAllowInteractiveTopInputs: (v: boolean) => void;
    setSteppingActive?: (docUri: string, value: boolean) => void;
    primeGlobalsForDoc?: (docUri: string, list: Array<{ name: string; value: any; type: string; control?: VarControl; readonly?: boolean }>) => void;
    updateVariablesPanel?: () => void;
    setHasDraw?: (docUri: string, value: boolean) => void;
    setDrawLoopPaused?: (docUri: string, paused: boolean) => void;
  }
) {
  const { panel, editor } = params;
  const docUri = editor.document.uri.toString();
  const fileName = require('path').basename(editor.document.fileName);
  const rawCode = editor.document.getText();
  try {
    const drawPresent = detectDrawFunction(rawCode);
    deps.setHasDraw?.(docUri, drawPresent);
    deps.setDrawLoopPaused?.(docUri, false);
  } catch { }
  const docStepMap = buildStepMap(rawCode);
  const delayMs = cfg.getStepRunDelayMs();
  const suppressGlobalsInPanel = /\bfunction\s+(setup|draw)\s*\(/.test(rawCode);

  // If already stepping, enable auto-advance from current position
  if ((panel as any)._steppingActive) {
    if (!(panel as any)._autoStepMode) {
      try { const ch = deps.getOrCreateOutputChannel(docUri, fileName); ch.appendLine(`${deps.getTime()} [▶️INFO] Switched to STEP-RUN: continuing from current statement with ${delayMs}ms delay.`); } catch { }
    }
    if ((panel as any)._autoStepTimer) { try { clearInterval((panel as any)._autoStepTimer); } catch { } (panel as any)._autoStepTimer = null; }
    (panel as any)._autoStepMode = true;
    (panel as any)._autoStepTimer = setInterval(() => { try { panel.webview.postMessage({ type: 'step-advance' }); } catch { } }, delayMs);
    (panel as any)._suppressHighlightUntilBreakpoint = false;
    try { deps.setSteppingActive?.(docUri, true); } catch { }
    return;
  }

  // Not stepping yet: instrument with single-step and start auto-advance
  if (deps.hasNonTopInputUsage(rawCode)) {
    panel.webview.html = await deps.createHtml('', panel, deps.getExtensionPath(), { allowInteractiveTopInputs: deps.getAllowInteractiveTopInputs(), initialCaptureVisible: deps.getInitialCaptureVisible(panel) });
    setTimeout(() => { panel.webview.postMessage({ type: 'showError', message: 'input can only be used at the top' }); }, 150);
    try { const ch = deps.getOrCreateOutputChannel(docUri, fileName); ch.appendLine(`${deps.getTime()} [‼️RUNTIME ERROR in ${fileName}] input can only be used at the top`); } catch { }
    return;
  }
  // Log warnings
  deps.lintApi.logSemicolonWarningsForDocument(editor.document);
  deps.lintApi.logUndeclaredWarningsForDocument(editor.document);
  deps.lintApi.logVarWarningsForDocument(editor.document);
  deps.lintApi.logEqualityWarningsForDocument(editor.document);
  // Optionally block on warning
  {
    const blockOnWarning = cfg.getBlockSketchOnWarning();
    const warnSemi = deps.lintApi.hasSemicolonWarnings(editor.document);
    const warnUnd = deps.lintApi.hasUndeclaredWarnings(editor.document);
    const warnVar = deps.lintApi.hasVarWarnings(editor.document);
    const warnEq = deps.lintApi.hasEqualityWarnings(editor.document);
    if (blockOnWarning && (warnSemi.has || warnUnd.has || warnVar.has || warnEq.has)) {
      panel.webview.html = await deps.createHtml('', panel, deps.getExtensionPath(), { allowInteractiveTopInputs: deps.getAllowInteractiveTopInputs(), initialCaptureVisible: deps.getInitialCaptureVisible(panel) });
      deps.lintApi.logBlockingWarningsForDocument(editor.document);
      return;
    }
  }
  // Reserved-name conflicts block execution
  const { conflicts } = deps.extractGlobalVariablesWithConflicts(rawCode);
  if (conflicts.length > 0) {
    let syntaxErrorMsg = `${deps.getTime()} [‼️SYNTAX ERROR in ${fileName}] Reserved variable name(s) used: ${conflicts.join(', ')}`;
    syntaxErrorMsg = require('util').isFunction((deps as any).formatSyntaxErrorMsg) ? (deps as any).formatSyntaxErrorMsg(syntaxErrorMsg) : syntaxErrorMsg;
    panel.webview.html = await deps.createHtml('', panel, deps.getExtensionPath(), { allowInteractiveTopInputs: deps.getAllowInteractiveTopInputs(), initialCaptureVisible: deps.getInitialCaptureVisible(panel) });
    setTimeout(() => { panel.webview.postMessage({ type: 'syntaxError', message: syntaxErrorMsg.replace(/^\d{2}:\d{2}:\d{2}\s+/, '') }); }, 150);
    try { const ch = deps.getOrCreateOutputChannel(docUri, fileName); ch.appendLine(syntaxErrorMsg); } catch { }
    (panel as any)._lastSyntaxError = syntaxErrorMsg;
    (panel as any)._lastRuntimeError = null;
    return;
  }

  const templateInfo = findFirstTemplateLiteral(rawCode);
  if (templateInfo) {
    const friendly = formatTemplateLiteralError(deps.getTime, fileName, templateInfo);
    panel.webview.html = await deps.createHtml('', panel, deps.getExtensionPath(), { allowInteractiveTopInputs: deps.getAllowInteractiveTopInputs(), initialCaptureVisible: deps.getInitialCaptureVisible(panel) });
    setTimeout(() => { panel.webview.postMessage({ type: 'showError', message: friendly }); }, 150);
    try { const ch = deps.getOrCreateOutputChannel(docUri, fileName); ch.appendLine(friendly); } catch { }
    (panel as any)._lastRuntimeError = friendly;
    (panel as any)._lastSyntaxError = null;
    return;
  }

  // Handle top-level inputPrompt() placeholders with cache-aware preprocessing
  const inputsBefore = deps.detectTopLevelInputs(rawCode);
  let codeForRun = rawCode;
  if (inputsBefore.length > 0) {
    const key = editor.document.fileName;
    if (deps.hasCachedInputsForKey(key, inputsBefore)) {
      const prev = deps.getAllowInteractiveTopInputs();
      deps.setAllowInteractiveTopInputs(false);
      codeForRun = await deps.preprocessTopLevelInputs(rawCode, { key, interactive: false });
      deps.setAllowInteractiveTopInputs(prev);
    } else {
      panel.webview.html = await deps.createHtml('', panel, deps.getExtensionPath(), { allowInteractiveTopInputs: deps.getAllowInteractiveTopInputs(), initialCaptureVisible: deps.getInitialCaptureVisible(panel) });
      setTimeout(() => { panel.webview.postMessage({ type: 'showTopInputs', items: inputsBefore }); }, 150);
      return;
    }
  }

  let wrapped = deps.wrapInSetupIfNeeded(codeForRun);
  const didWrap = wrapped !== codeForRun;
  wrapped = deps.rewriteFrameCountRefs(wrapped);
  const preGlobals = deps.extractGlobalVariables(wrapped);
  const lineOffsetTotal = computeLineOffset(codeForRun, wrapped, didWrap);
  const globalsPayload = (() => {
    const { globals } = deps.extractGlobalVariablesWithConflicts(wrapped);
    let filteredGlobals = globals.filter(g => ['number', 'string', 'boolean', 'array'].includes(g.type));
    const hiddenSet = deps.getHiddenGlobalsByDirective(rawCode);
    if (hiddenSet.size > 0) { filteredGlobals = filteredGlobals.filter(g => !hiddenSet.has(g.name)); }
    const readOnly = deps.hasOnlySetup(rawCode);
    return { filteredGlobals, readOnly };
  })();
  const revealableGlobals = globalsPayload.filteredGlobals.map(g => g.name);
  let instrumented = deps.instrumentSetupForSingleStep(wrapped, lineOffsetTotal, { docStepMap, topLevelGlobals: revealableGlobals });
  try {
    const ch = deps.getOrCreateOutputChannel(docUri, fileName);
    ch.appendLine(`${deps.getTime()} [DEBUG] Instrumented code for STEP-RUN (didWrap=${didWrap}, lineOffset=${lineOffsetTotal}):`);
    ch.appendLine(instrumented.split('\n').map((l, i) => `${(i + 1).toString().padStart(3, '0')}: ${l}`).join('\n'));
  } catch { }
  const globals = preGlobals;
  let rewrittenCode = deps.rewriteUserCodeWithWindowGlobals(instrumented, globals);
  deps.primeGlobalsForDoc?.(docUri, globalsPayload.filteredGlobals);
  deps.updateVariablesPanel?.();
  const hasDraw = detectDrawFunction(wrapped);
  try {
    deps.setHasDraw?.(docUri, hasDraw);
    if (!hasDraw) deps.setDrawLoopPaused?.(docUri, false);
  } catch { }
  try { const ch = deps.getOrCreateOutputChannel(docUri, fileName); ch.appendLine(`${deps.getTime()} [▶️INFO] STEP-RUN started: auto-advancing with ${delayMs}ms delay.`); } catch { }
  const afterLoad = () => {
    panel.webview.postMessage({
      type: 'setGlobalVars',
      variables: globalsPayload.filteredGlobals,
      readOnly: globalsPayload.readOnly,
      suppressPanel: suppressGlobalsInPanel,
    });
    (panel as any)._steppingActive = true;
    (panel as any)._suppressHighlightUntilBreakpoint = false;
    try { deps.setSteppingActive?.(docUri, true); } catch { }
    if ((panel as any)._autoStepTimer) { try { clearInterval((panel as any)._autoStepTimer); } catch { } (panel as any)._autoStepTimer = null; }
    (panel as any)._autoStepMode = true;
    (panel as any)._autoStepTimer = setInterval(() => { try { panel.webview.postMessage({ type: 'step-advance' }); } catch { } }, delayMs);

    // If there are no top-level or setup steps but there are draw steps, immediately advance to the first draw step
    const hasTopOrSetup = docStepMap.steps.some(s => s.phase === 'top-level' || s.phase === 'setup');
    const hasDrawStep = docStepMap.steps.some(s => s.phase === 'draw');
    if (!hasTopOrSetup && hasDrawStep) {
      setTimeout(() => { panel.webview.postMessage({ type: 'step-advance' }); }, 100);
    }
  };
  if (!hasDraw) {
    panel.webview.html = await deps.createHtml(instrumented, panel, deps.getExtensionPath(), { allowInteractiveTopInputs: deps.getAllowInteractiveTopInputs(), initialCaptureVisible: deps.getInitialCaptureVisible(panel) });
    setTimeout(afterLoad, 200);
  } else {
    panel.webview.postMessage({ type: 'reload', code: rewrittenCode, preserveGlobals: false });
    setTimeout(afterLoad, 200);
  }
}

export async function handleContinueClicked(
  params: { panel: vscode.WebviewPanel; editor: vscode.TextEditor },
  deps: {
    getTime: () => string;
    getOrCreateOutputChannel: (docUri: string, fileName: string) => vscode.OutputChannel;
    setSteppingActive?: (docUri: string, value: boolean) => void;
  }
) {
  const { panel, editor } = params;
  const docUri = editor.document.uri.toString();
  const fileName = require('path').basename(editor.document.fileName);
  try {
    if (!(panel as any)._steppingActive) {
      const ch = deps.getOrCreateOutputChannel(docUri, fileName);
      ch.appendLine(`${deps.getTime()} [⚠️INFO] Continue requested but stepping is not active. Use SINGLE-STEP or STEP-RUN first.`);
      return;
    }
    deps.setSteppingActive?.(docUri, true);
    const ch = deps.getOrCreateOutputChannel(docUri, fileName);
    ch.appendLine(`${deps.getTime()} [⏩INFO] Continuing to the next breakpoint.`);
  } catch { }

  if ((panel as any)._autoStepTimer) {
    try { clearInterval((panel as any)._autoStepTimer); } catch { }
    (panel as any)._autoStepTimer = null;
  }

  (panel as any)._autoStepMode = true;
  (panel as any)._steppingActive = true;
  (panel as any)._suppressHighlightUntilBreakpoint = true;
  const fastAdvance = () => {
    try {
      if (!(panel as any)._autoStepMode) return;
      panel.webview.postMessage({ type: 'step-advance' });
    } catch { }
  };
  // Kick once immediately so we leave the current paused state.
  fastAdvance();
  (panel as any)._autoStepTimer = setInterval(fastAdvance, 1);
}

export async function handleSingleStepClicked(
  params: { panel: vscode.WebviewPanel; editor: vscode.TextEditor },
  deps: {
    getTime: () => string;
    getOrCreateOutputChannel: (docUri: string, fileName: string) => vscode.OutputChannel;
    lintApi: {
      logSemicolonWarningsForDocument: (doc: vscode.TextDocument) => void;
      logUndeclaredWarningsForDocument: (doc: vscode.TextDocument) => void;
      logVarWarningsForDocument: (doc: vscode.TextDocument) => void;
      hasSemicolonWarnings: (doc: vscode.TextDocument) => { has: boolean };
      hasUndeclaredWarnings: (doc: vscode.TextDocument) => { has: boolean };
      hasVarWarnings: (doc: vscode.TextDocument) => { has: boolean };
      getStrictLevel: (rule: 'Semicolon' | 'Undeclared' | 'NoVar') => 'warn' | 'block' | 'ignore';
      logBlockingWarningsForDocument: (doc: vscode.TextDocument) => void;
    };
    hasNonTopInputUsage: (code: string) => boolean;
    detectTopLevelInputs: (code: string) => Array<{ varName: string; label?: string; defaultValue?: any }>;
    hasCachedInputsForKey: (key: string, items: Array<{ varName: string; label?: string }>) => boolean;
    preprocessTopLevelInputs: (code: string, opts: { key: string; interactive: boolean }) => Promise<string>;
    wrapInSetupIfNeeded: (code: string) => string;
    rewriteFrameCountRefs: (code: string) => string;
    instrumentSetupForSingleStep: (code: string, lineOffset: number, opts?: { disableTopLevelPreSteps?: boolean; docStepMap?: StepMap; topLevelGlobals?: string[] }) => string;
    extractGlobalVariablesWithConflicts: (code: string) => { globals: Array<{ name: string; value: any; type: string; control?: VarControl; readonly?: boolean }>; conflicts: string[] };
    extractGlobalVariables: (code: string) => Array<{ name: string; value: any; type: string; control?: VarControl; readonly?: boolean }>;
    rewriteUserCodeWithWindowGlobals: (code: string, globals: Array<{ name: string; value?: any; control?: VarControl; readonly?: boolean }>) => string;
    getHiddenGlobalsByDirective: (code: string) => Set<string>;
    hasOnlySetup: (code: string) => boolean;
    createHtml: (code: string, panel: vscode.WebviewPanel, extensionPath: string, opts?: { allowInteractiveTopInputs?: boolean; initialCaptureVisible?: boolean }) => Promise<string>;
    getInitialCaptureVisible: (panel: vscode.WebviewPanel) => boolean;
    getExtensionPath: () => string;
    setSteppingActive?: (docUri: string, value: boolean) => void;
    primeGlobalsForDoc?: (docUri: string, list: Array<{ name: string; value: any; type: string; control?: VarControl; readonly?: boolean }>) => void;
    updateVariablesPanel?: () => void;
    setHasDraw?: (docUri: string, value: boolean) => void;
    setDrawLoopPaused?: (docUri: string, paused: boolean) => void;
  }
) {
  const { panel, editor } = params;
  const docUri = editor.document.uri.toString();
  const fileName = require('path').basename(editor.document.fileName);
  const rawCode = editor.document.getText();
  try {
    const drawPresent = detectDrawFunction(rawCode);
    deps.setHasDraw?.(docUri, drawPresent);
    deps.setDrawLoopPaused?.(docUri, false);
  } catch { }
  const docStepMap = buildStepMap(rawCode);
  const suppressGlobalsInPanel = /\bfunction\s+(setup|draw)\s*\(/.test(rawCode);

  let wasAutoStepMode = (panel as any)._autoStepMode;
  if ((panel as any)._autoStepTimer) {
    try { clearInterval((panel as any)._autoStepTimer); } catch { }
    (panel as any)._autoStepTimer = null;
    (panel as any)._autoStepMode = false;
  }
  (panel as any)._suppressHighlightUntilBreakpoint = false;
  const isStepping = !!(panel as any)._steppingActive;
  if (isStepping) {
    if (wasAutoStepMode) {
      try { const ch = deps.getOrCreateOutputChannel(docUri, fileName); ch.appendLine(`${deps.getTime()} [⏯️INFO] Switched to SINGLE-STEP, click again to step trough statements.`); } catch { }
    }
    try { deps.setSteppingActive?.(docUri, true); } catch { }
    panel.webview.postMessage({ type: 'step-advance' });
    return;
  }

  // Start stepping
  try {
    const ch = deps.getOrCreateOutputChannel(docUri, fileName);
    if (wasAutoStepMode) ch.appendLine(`${deps.getTime()} [⏯️INFO] Switched to SINGLE-STEP, click again to step trough statements.`);
    else ch.appendLine(`${deps.getTime()} [⏯️INFO] SINGLE-STEP started, click again to step trough statements.`);
  } catch { }

  if (deps.hasNonTopInputUsage(rawCode)) {
    panel.webview.html = await deps.createHtml('', panel, deps.getExtensionPath());
    setTimeout(() => { panel.webview.postMessage({ type: 'showError', message: 'input can only be used at the top' }); }, 150);
    try { const ch = deps.getOrCreateOutputChannel(docUri, fileName); ch.appendLine(`${deps.getTime()} [‼️RUNTIME ERROR in ${fileName}] input can only be used at the top`); } catch { }
    return;
  }
  deps.lintApi.logSemicolonWarningsForDocument(editor.document);
  deps.lintApi.logUndeclaredWarningsForDocument(editor.document);
  deps.lintApi.logVarWarningsForDocument(editor.document);
  {
    const warnSemi = deps.lintApi.hasSemicolonWarnings(editor.document);
    const warnUnd = deps.lintApi.hasUndeclaredWarnings(editor.document);
    const warnVar = deps.lintApi.hasVarWarnings(editor.document);
    const shouldBlock = (deps.lintApi.getStrictLevel('Semicolon') === 'block' && warnSemi.has)
      || (deps.lintApi.getStrictLevel('Undeclared') === 'block' && warnUnd.has)
      || (deps.lintApi.getStrictLevel('NoVar') === 'block' && warnVar.has);
    if (shouldBlock) {
      panel.webview.html = await deps.createHtml('', panel, deps.getExtensionPath());
      deps.lintApi.logBlockingWarningsForDocument(editor.document);
      return;
    }
  }
  const { conflicts } = deps.extractGlobalVariablesWithConflicts(rawCode);
  if (conflicts.length > 0) {
    let syntaxErrorMsg = `${deps.getTime()} [‼️SYNTAX ERROR in ${fileName}] Reserved variable name(s) used: ${conflicts.join(', ')}`;
    panel.webview.html = await deps.createHtml('', panel, deps.getExtensionPath());
    setTimeout(() => { panel.webview.postMessage({ type: 'syntaxError', message: syntaxErrorMsg.replace(/^\d{2}:\d{2}:\d{2}\s+/, '') }); }, 150);
    try { const ch = deps.getOrCreateOutputChannel(docUri, fileName); ch.appendLine(syntaxErrorMsg); } catch { }
    (panel as any)._lastSyntaxError = syntaxErrorMsg;
    (panel as any)._lastRuntimeError = null;
    return;
  }

  const templateInfo = findFirstTemplateLiteral(rawCode);
  if (templateInfo) {
    const friendly = formatTemplateLiteralError(deps.getTime, fileName, templateInfo);
    panel.webview.html = await deps.createHtml('', panel, deps.getExtensionPath());
    setTimeout(() => { panel.webview.postMessage({ type: 'showError', message: friendly }); }, 150);
    try { const ch = deps.getOrCreateOutputChannel(docUri, fileName); ch.appendLine(friendly); } catch { }
    (panel as any)._lastRuntimeError = friendly;
    (panel as any)._lastSyntaxError = null;
    return;
  }

  let codeForRun = rawCode;
  const inputsBefore = deps.detectTopLevelInputs(rawCode);
  if (inputsBefore.length > 0) {
    const key = editor.document.fileName;
    if (deps.hasCachedInputsForKey(key, inputsBefore)) {
      codeForRun = await deps.preprocessTopLevelInputs(rawCode, { key, interactive: false });
    } else {
      panel.webview.html = await deps.createHtml('', panel, deps.getExtensionPath());
      setTimeout(() => { panel.webview.postMessage({ type: 'showTopInputs', items: inputsBefore }); }, 150);
      return;
    }
  }

  let wrapped = deps.wrapInSetupIfNeeded(codeForRun);
  const didWrap = wrapped !== codeForRun;
  wrapped = deps.rewriteFrameCountRefs(wrapped);
  const preGlobals = deps.extractGlobalVariables(wrapped);
  const lineOffsetTotal = computeLineOffset(codeForRun, wrapped, didWrap);
  const globalsPayload = (() => {
    const { globals } = deps.extractGlobalVariablesWithConflicts(wrapped);
    let filteredGlobals = globals.filter(g => ['number', 'string', 'boolean', 'array'].includes(g.type));
    const hiddenSet = deps.getHiddenGlobalsByDirective(rawCode);
    if (hiddenSet.size > 0) { filteredGlobals = filteredGlobals.filter(g => !hiddenSet.has(g.name)); }
    const readOnly = deps.hasOnlySetup(rawCode);
    return { filteredGlobals, readOnly };
  })();
  const revealableGlobals = globalsPayload.filteredGlobals.map(g => g.name);
  let instrumented = deps.instrumentSetupForSingleStep(wrapped, lineOffsetTotal, { docStepMap, topLevelGlobals: revealableGlobals });
  const globals = preGlobals;
  let rewrittenCode = deps.rewriteUserCodeWithWindowGlobals(instrumented, globals);
  deps.primeGlobalsForDoc?.(docUri, globalsPayload.filteredGlobals);
  deps.updateVariablesPanel?.();
  const hasDraw = detectDrawFunction(wrapped);
  try {
    deps.setHasDraw?.(docUri, hasDraw);
    if (!hasDraw) deps.setDrawLoopPaused?.(docUri, false);
  } catch { }
  const sendGlobals = () => {
    panel.webview.postMessage({
      type: 'setGlobalVars',
      variables: globalsPayload.filteredGlobals,
      readOnly: globalsPayload.readOnly,
      suppressPanel: suppressGlobalsInPanel,
    });
    (panel as any)._steppingActive = true;
    try { deps.setSteppingActive?.(docUri, true); } catch { }
  };
  if (!hasDraw) {
    panel.webview.html = await deps.createHtml(instrumented, panel, deps.getExtensionPath());
    setTimeout(sendGlobals, 200);
  } else {
    panel.webview.postMessage({ type: 'reload', code: rewrittenCode, preserveGlobals: false });
    setTimeout(sendGlobals, 200);
  }
}
