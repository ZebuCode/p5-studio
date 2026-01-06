import * as vscode from 'vscode';
import * as fs from 'fs';
import { LIVE_PANEL_VIEWTYPE, BLOCKLY_PANEL_VIEWTYPE } from '../panels/registry';

export type RestoreApiDeps = {
  migrate: () => Promise<void>;
  getRestoreList: (key: string) => string[];
};

export type LayoutDeps = {
  restore: RestoreApiDeps;
  RESTORE_LIVE_KEY: string;
  RESTORE_BLOCKLY_KEY: string;
  RESTORE_LIVE_ORDER_KEY: string;
  isInWorkspace: (fsPath: string) => boolean;
  isSingleP5PanelEnabled: () => boolean;
  openLiveForFsPath: (fsPath: string) => Promise<void>;
  openBlocklyForFsPath: (fsPath: string) => Promise<void>;
};

export type LayoutRestoreApi = {
  beginRestore: () => Promise<void>;
  isRestoring: () => boolean;
  computeTargetColumnForLive: () => Promise<vscode.ViewColumn>;
  ensureEditorInLeftColumn: (editor: vscode.TextEditor) => Promise<void>;
};

export function registerLayoutRestore(context: vscode.ExtensionContext, deps: LayoutDeps): LayoutRestoreApi {
  let _restoringPanels = false;
  let _restoreP5TargetColumn: vscode.ViewColumn | undefined;

  async function prepareP5RestoreTargetGroup() {
    try {
      await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
      const before = vscode.window.tabGroups.activeTabGroup;
      await vscode.commands.executeCommand('workbench.action.focusRightGroup');
      let after = vscode.window.tabGroups.activeTabGroup;
      if (!after || (before && after.viewColumn === before.viewColumn)) {
        try { await vscode.commands.executeCommand('workbench.action.newGroupRight'); }
        catch { try { await vscode.commands.executeCommand('workbench.action.splitEditorRight'); } catch { /* ignore */ } }
        await vscode.commands.executeCommand('workbench.action.focusRightGroup');
        await new Promise(r => setTimeout(r, 100));
        after = vscode.window.tabGroups.activeTabGroup;
      }
      if (after && typeof after.viewColumn === 'number') {
        _restoreP5TargetColumn = after.viewColumn as vscode.ViewColumn;
      }
    } catch {
      _restoreP5TargetColumn = vscode.ViewColumn.Beside;
    }
  }

  async function beginRestore() {
    try {
      try { await deps.restore.migrate(); } catch { }
      try {
        const groups: readonly vscode.TabGroup[] = (vscode.window.tabGroups as any).all || [vscode.window.tabGroups.activeTabGroup];
        const toClose: vscode.Tab[] = [] as any;
        for (const g of groups || []) {
          for (const t of (g?.tabs || [])) {
            try {
              const input: any = (t as any).input;
              const vt = input && typeof input.viewType === 'string' ? String(input.viewType) : '';
              if (vt === LIVE_PANEL_VIEWTYPE || vt === BLOCKLY_PANEL_VIEWTYPE) {
                toClose.push(t as any);
              }
            } catch { }
          }
        }
        if (toClose.length) {
          try { await (vscode.window.tabGroups as any).close(toClose, true); } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
      _restoringPanels = true;

      const blkDocs = deps.restore.getRestoreList(deps.RESTORE_BLOCKLY_KEY)
        .filter(p => typeof p === 'string' && p)
        .filter(p => fs.existsSync(p) && deps.isInWorkspace(p));
      const uniqueBlk = Array.from(new Set(blkDocs));
      for (const fsPath of uniqueBlk) {
        try { await deps.openBlocklyForFsPath(fsPath); await new Promise(r => setTimeout(r, 150)); } catch { }
      }

      const liveDocs = deps.restore.getRestoreList(deps.RESTORE_LIVE_KEY)
        .filter(p => typeof p === 'string' && p)
        .filter(p => fs.existsSync(p) && deps.isInWorkspace(p));
      const uniqueLive = Array.from(new Set(liveDocs));
      if (uniqueLive.length) {
        // Prepare right-hand top-row group for P5 panels only when we will restore one
        await prepareP5RestoreTargetGroup();
        const savedOrder = deps.restore.getRestoreList(deps.RESTORE_LIVE_ORDER_KEY).filter(p => fs.existsSync(p) && deps.isInWorkspace(p));
        const orderIndex = new Map<string, number>();
        savedOrder.forEach((p, i) => orderIndex.set(p, i));
        uniqueLive.sort((a, b) => {
          const ia = orderIndex.has(a) ? (orderIndex.get(a) as number) : Number.MAX_SAFE_INTEGER;
          const ib = orderIndex.has(b) ? (orderIndex.get(b) as number) : Number.MAX_SAFE_INTEGER;
          if (ia !== ib) return ia - ib;
          return 0;
        });
        const single = deps.isSingleP5PanelEnabled();
        const targets = single ? [uniqueLive[uniqueLive.length - 1]] : uniqueLive;
        for (const fsPath of targets) {
          try { await deps.openLiveForFsPath(fsPath); await new Promise(r => setTimeout(r, 150)); } catch { }
        }
      }
    } catch { /* ignore */ }
    finally {
      _restoringPanels = false;
    }
  }

  async function computeTargetColumnForLive(): Promise<vscode.ViewColumn> {
    if (_restoringPanels) {
      try { await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup'); } catch { }
      return vscode.ViewColumn.Beside;
    }
    // Manual open: anchor to top row, create/focus right group
    let target: vscode.ViewColumn = vscode.ViewColumn.Beside;
    try {
      await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
      const before = vscode.window.tabGroups.activeTabGroup;
      await vscode.commands.executeCommand('workbench.action.focusRightGroup');
      let after = vscode.window.tabGroups.activeTabGroup;
      if (!after || (before && after.viewColumn === before.viewColumn)) {
        try { await vscode.commands.executeCommand('workbench.action.newGroupRight'); }
        catch { try { await vscode.commands.executeCommand('workbench.action.splitEditorRight'); } catch { /* ignore */ } }
        await vscode.commands.executeCommand('workbench.action.focusRightGroup');
        await new Promise(r => setTimeout(r, 100));
        after = vscode.window.tabGroups.activeTabGroup;
      }
      if (after && typeof after.viewColumn === 'number') target = after.viewColumn as vscode.ViewColumn;
    } catch { }
    return target;
  }

  return {
    beginRestore,
    isRestoring: () => _restoringPanels,
    computeTargetColumnForLive,
    async ensureEditorInLeftColumn(editor: vscode.TextEditor) {
      if (!editor || editor.document.uri.scheme !== 'file') return;
      if (editor.viewColumn && editor.viewColumn !== vscode.ViewColumn.One && vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri.toString() === editor.document.uri.toString()) {
        const alreadyOpenInLeft = vscode.window.visibleTextEditors.some(e => e.document.uri.toString() === editor.document.uri.toString() && e.viewColumn === vscode.ViewColumn.One);
        if (!alreadyOpenInLeft) {
          await vscode.window.showTextDocument(editor.document, vscode.ViewColumn.One, false);
          const closePromises: Thenable<any>[] = [];
          vscode.window.visibleTextEditors.forEach(e => {
            if (e.document.uri.toString() === editor.document.uri.toString() && e.viewColumn !== vscode.ViewColumn.One) {
              closePromises.push(vscode.window.showTextDocument(e.document, e.viewColumn, false).then(() => vscode.commands.executeCommand('workbench.action.closeActiveEditor')));
            }
          });
          try { await Promise.all(closePromises); } catch { }
          try { await vscode.window.showTextDocument(editor.document, vscode.ViewColumn.One, false); } catch { }
        }
      }
    },
  };
}
