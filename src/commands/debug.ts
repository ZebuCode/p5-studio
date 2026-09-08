import * as vscode from 'vscode';

export function registerDebugCommands(
  context: vscode.ExtensionContext,
  deps: {
    getActiveP5Panel: () => vscode.WebviewPanel | undefined;
    getDocUriForPanel: (panel: vscode.WebviewPanel) => vscode.Uri | undefined;
    invokeStepRun: (panel: vscode.WebviewPanel, editor: vscode.TextEditor) => Promise<void>;
    invokeContinue: (panel: vscode.WebviewPanel, editor: vscode.TextEditor) => Promise<void>;
    invokeSingleStep: (panel: vscode.WebviewPanel, editor: vscode.TextEditor) => Promise<void>;
    invokeStepInto: (panel: vscode.WebviewPanel, editor: vscode.TextEditor) => Promise<void>;
    contextService: {
      setDebugPrimed: (docUri: string, value: boolean) => void;
      setContext: (k: string, v: any) => Thenable<unknown>;
      setSteppingActive: (docUri: string, value: boolean) => void;
    };
  }
) {
  context.subscriptions.push(vscode.commands.registerCommand('P5Studio.stepRun', async () => {
    let editor = vscode.window.activeTextEditor;
    const panel = deps.getActiveP5Panel();
    if (!panel) return;
    if (!editor) {
      const uri = deps.getDocUriForPanel(panel);
      if (uri) {
        try { editor = await vscode.window.showTextDocument(uri, { preview: true, preserveFocus: true, viewColumn: vscode.ViewColumn.One }); } catch { /* ignore */ }
      }
    }
    if (!editor) return;
    try {
      const docUri = editor.document.uri.toString();
      deps.contextService.setSteppingActive(docUri, true);
      await deps.contextService.setContext('p5SteppingActive', true);
    } catch { }
    await deps.invokeStepRun(panel, editor);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('P5Studio.continueToBreakpoint', async () => {
    let editor = vscode.window.activeTextEditor;
    const panel = deps.getActiveP5Panel();
    if (!panel) return;
    if (!editor) {
      const uri = deps.getDocUriForPanel(panel);
      if (uri) {
        try { editor = await vscode.window.showTextDocument(uri, { preview: true, preserveFocus: true, viewColumn: vscode.ViewColumn.One }); } catch { /* ignore */ }
      }
    }
    if (!editor) return;
    try {
      const docUri = editor.document.uri.toString();
      deps.contextService.setSteppingActive(docUri, true);
      await deps.contextService.setContext('p5SteppingActive', true);
    } catch { }
    await deps.invokeContinue(panel, editor);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('P5Studio.singleStep', async () => {
    let editor = vscode.window.activeTextEditor;
    const panel = deps.getActiveP5Panel();
    if (!panel) return;
    if (!editor) {
      const uri = deps.getDocUriForPanel(panel);
      if (uri) {
        try { editor = await vscode.window.showTextDocument(uri, { preview: true, preserveFocus: true, viewColumn: vscode.ViewColumn.One }); } catch { /* ignore */ }
      }
    }
    if (!editor) return;
    try {
      const docUri = editor.document.uri.toString();
      deps.contextService.setSteppingActive(docUri, true);
      await deps.contextService.setContext('p5SteppingActive', true);
    } catch { }
    await deps.invokeSingleStep(panel, editor);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('P5Studio.stepInto', async () => {
    let editor = vscode.window.activeTextEditor;
    const panel = deps.getActiveP5Panel();
    if (!panel) return;
    if (!editor) {
      const uri = deps.getDocUriForPanel(panel);
      if (uri) {
        try { editor = await vscode.window.showTextDocument(uri, { preview: true, preserveFocus: true, viewColumn: vscode.ViewColumn.One }); } catch { /* ignore */ }
      }
    }
    if (!editor) return;
    try {
      const docUri = editor.document.uri.toString();
      deps.contextService.setSteppingActive(docUri, true);
      await deps.contextService.setContext('p5SteppingActive', true);
    } catch { }
    await deps.invokeStepInto(panel, editor);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('P5Studio.debugPrime', async () => {
    const panel = deps.getActiveP5Panel();
    if (!panel) return;
    let editor = vscode.window.activeTextEditor;
    if (!editor) {
      const uri = deps.getDocUriForPanel(panel);
      if (uri) {
        try { editor = await vscode.window.showTextDocument(uri, { preview: true, preserveFocus: true, viewColumn: vscode.ViewColumn.One }); } catch { /* ignore */ }
      }
    }
    if (!editor) return;
    try {
      const docUri = editor.document.uri.toString();
      deps.contextService.setSteppingActive(docUri, true);
      await deps.contextService.setContext('p5SteppingActive', true);
    } catch { }
    await deps.invokeSingleStep(panel, editor);
    try {
      const docUri = editor.document.uri.toString();
      deps.contextService.setDebugPrimed(docUri, true);
      await deps.contextService.setContext('p5DebugPrimed', true);
    } catch { }
  }));
}
