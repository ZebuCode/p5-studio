import * as vscode from 'vscode';

export function handleHighlightLine(
  params: { panel: vscode.WebviewPanel; editor: vscode.TextEditor; line?: number; rawLine?: number; stepId?: number; virtualBreakpoint?: boolean },
  deps: {
    getTime: () => string;
    getOrCreateOutputChannel: (docUri: string, fileName: string) => vscode.OutputChannel;
    applyStepHighlight: (editor: vscode.TextEditor, line: number) => void;
    hasBreakpointOnLine: (docUriStr: string, line1Based: number) => boolean;
    blocklyHighlightForLine: (docUri: string, line: number) => void;
  }
) {
  const { panel, editor } = params;
  const docUri = editor.document.uri.toString();
  const line = typeof params.line === 'number' ? params.line : 1;
  const rawLine = (typeof params.rawLine === 'number' && params.rawLine > 0) ? params.rawLine : undefined;
  const stepId = (typeof params.stepId === 'number' && params.stepId > 0) ? params.stepId : undefined;
  const virtualBreakpoint = !!params.virtualBreakpoint;
  const candidateLines = rawLine && rawLine !== line ? [line, rawLine] : [line];
  const suppressUntilBreakpoint = !!(panel as any)._suppressHighlightUntilBreakpoint;
  const continueBreakpointSet = (panel as any)._continueBreakpointLines as Set<number> | undefined;
  let lineHasBreakpoint = false;
  let rawLineHasBreakpoint = false;
  let hasBreakpoint = false;
  let lineSetHit = false;
  let liveBreakpoint = false;
  let skippedCurrentStep = false;
  if (suppressUntilBreakpoint && continueBreakpointSet instanceof Set) {
    for (const ln of candidateLines) {
      try {
        if (deps.hasBreakpointOnLine(docUri, ln)) {
          liveBreakpoint = true;
          if (ln === line) lineHasBreakpoint = true;
          if (typeof rawLine === 'number' && ln === rawLine) rawLineHasBreakpoint = true;
          break;
        }
      } catch { }
    }
    lineSetHit = candidateLines.some((ln) => continueBreakpointSet.has(ln));
    // In continue mode with step-id instrumentation, runtime virtualBreakpoint is authoritative.
    // Falling back to host line checks here can re-pause the currently skipped step.
    if (typeof stepId === 'number') {
      hasBreakpoint = virtualBreakpoint;
    } else {
      hasBreakpoint = virtualBreakpoint || lineSetHit || liveBreakpoint;
    }
  } else {
    if (virtualBreakpoint) {
      hasBreakpoint = true;
    }
    for (const ln of candidateLines) {
      try {
        if (deps.hasBreakpointOnLine(docUri, ln)) {
          hasBreakpoint = true;
          if (ln === line) lineHasBreakpoint = true;
          if (typeof rawLine === 'number' && ln === rawLine) rawLineHasBreakpoint = true;
          break;
        }
      } catch { }
    }
  }
  // Prefer the raw line when it is the actual breakpoint line and mapped line is off by wrapper offset.
  const displayLine = (typeof rawLine === 'number' && rawLineHasBreakpoint && !lineHasBreakpoint) ? rawLine : line;
  try {
    (panel as any)._lastHighlightedStepId = stepId;
    (panel as any)._lastHighlightedDisplayLine = displayLine;
  } catch { }
  if (suppressUntilBreakpoint) {
    try {
      const skipStepId = Number((panel as any)._continueSkipStepId || 0);
      const skipConsumed = !!(panel as any)._continueSkipConsumed;
      if (!skipConsumed && skipStepId > 0 && typeof stepId === 'number' && stepId === skipStepId) {
        hasBreakpoint = false;
        skippedCurrentStep = true;
        (panel as any)._continueSkipConsumed = true;
      }
    } catch { }
  }
  if (suppressUntilBreakpoint) {
    try {
      const fileName = require('path').basename(editor.document.fileName);
      const ch = deps.getOrCreateOutputChannel(docUri, fileName);
      ch.appendLine(`${deps.getTime()} [DEBUG] continue-check step=${typeof stepId === 'number' ? stepId : '-'} line=${line} raw=${typeof rawLine === 'number' ? rawLine : '-'} display=${displayLine} virtual=${virtualBreakpoint ? 1 : 0} lineSet=${lineSetHit ? 1 : 0} live=${liveBreakpoint ? 1 : 0} skipStep=${skippedCurrentStep ? 1 : 0} hit=${hasBreakpoint ? 1 : 0}`);
    } catch { }
  }
  const shouldRenderHighlight = !suppressUntilBreakpoint || hasBreakpoint;
  let ed = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === docUri) || null;
  if (!ed && vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri.toString() === docUri) {
    ed = vscode.window.activeTextEditor;
  }
  if (shouldRenderHighlight) {
    if (ed && ed.document) {
      deps.applyStepHighlight(ed, displayLine);
    } else {
      try {
        const fileName = require('path').basename(editor.document.fileName);
        const ch = deps.getOrCreateOutputChannel(docUri, fileName);
        ch.appendLine(`${deps.getTime()} [ℹ️INFO] Highlight requested but sketch editor is not visible. Open the sketch to see line highlights.`);
      } catch { }
    }
    try { deps.blocklyHighlightForLine(docUri, displayLine); } catch { }
  }

  if ((panel as any)._autoStepMode && hasBreakpoint) {
    try {
      try { (panel as any)._lastPausedStepId = stepId; } catch { }
      try { (panel as any)._lastPausedDisplayLine = displayLine; } catch { }
      if ((panel as any)._autoStepTimer) {
        try { clearInterval((panel as any)._autoStepTimer); } catch { }
        (panel as any)._autoStepTimer = null;
      }
      (panel as any)._autoStepMode = false;
      (panel as any)._suppressHighlightUntilBreakpoint = false;
      try { (panel as any)._continueBreakpointLines = undefined; } catch { }
      try {
        (panel as any)._continueSkipStepId = undefined;
        (panel as any)._continueSkipConsumed = false;
      } catch { }
      try { panel.webview.postMessage({ type: 'set-fast-continue', enabled: false }); } catch { }
      const fileName = require('path').basename(editor.document.fileName);
      const ch = deps.getOrCreateOutputChannel(docUri, fileName);
      ch.appendLine(`${deps.getTime()} [⏸️INFO] Paused at breakpoint on line ${displayLine}. Click SINGLE-STEP to advance, CONTINUE to run to the next breakpoint, or STEP-RUN to auto-step.`);
    } catch { }
  }
}

export async function handleClearHighlight(
  params: { panel: vscode.WebviewPanel; editor: vscode.TextEditor; final?: boolean },
  deps: {
    clearStepHighlight: (editor?: vscode.TextEditor) => void;
    blocklyClearHighlight: (docUri: string) => void;
    getTime: () => string;
    getOrCreateOutputChannel: (docUri: string, fileName: string) => vscode.OutputChannel;
    setDebugPrimedFalse: (docUri: string) => void;
    setPrimedContextFalse: () => void | Thenable<any>;
    setSteppingActive: (docUri: string, value: boolean) => void;
  }
) {
  const { panel, editor, final: finalFromMsg } = params;
  const docUri = editor.document.uri.toString();
  let ed = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === docUri) || null;
  if (!ed && vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri.toString() === docUri) {
    ed = vscode.window.activeTextEditor;
  }
  if (ed && ed.document) { deps.clearStepHighlight(ed); }
  try { deps.blocklyClearHighlight(docUri); } catch { }
  try {
    const hasExplicitFinal = typeof finalFromMsg === 'boolean';
    const isFinal = hasExplicitFinal && finalFromMsg;
    // Only stop stepping when an explicit final=true is provided by the instrumenter.
    // Do NOT infer finalization from absence of draw(); this caused premature stops
    // during STEP-RUN when a timer tick arrived between awaited steps.
    const shouldStopStepping = isFinal;
    if (shouldStopStepping) {
      try { panel.webview.postMessage({ type: 'set-fast-continue', enabled: false }); } catch { }
      if ((panel as any)._autoStepTimer) {
        try { clearInterval((panel as any)._autoStepTimer); } catch { }
        (panel as any)._autoStepTimer = null;
      }
      (panel as any)._autoStepMode = false;
      try { (panel as any)._suppressHighlightUntilBreakpoint = false; } catch { }
      try { (panel as any)._continueBreakpointLines = undefined; } catch { }
      const fileName = require('path').basename(editor.document.fileName);
      const ch = deps.getOrCreateOutputChannel(docUri, fileName);
      ch.appendLine(`${deps.getTime()} [▶️INFO] Code stepping finished.`);
      (panel as any)._steppingActive = false;
      try { deps.setSteppingActive(docUri, false); } catch { }
      deps.setDebugPrimedFalse(docUri);
      try { await deps.setPrimedContextFalse(); } catch { }
    }
  } catch { }
}
