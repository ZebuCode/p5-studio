import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { BLOCKLY_PANEL_VIEWTYPE, BLOCKLY_PANEL_TITLE_PREFIX } from '../panels/registry';
import { config as cfg } from '../config';
import type { BlocklyToExtensionMessage } from './messageTypes';
import { postBlocklyMessage as sendBlockly, registerBlocklyRouter } from '../webview/router';

type Timeout = NodeJS.Timeout;

export type BlocklyApi = {
    clearHighlight: (docUri: string) => void;
    highlightForLine: (docUri: string, line: number) => void;
    disposePanelsForFilePath: (fsPath: string) => void;
    revealPanelForDocUri: (docUri: string, opts?: { preserveFocus?: boolean }) => boolean;
    disposeAllPanels: () => void;
};

export function registerBlockly(
    context: vscode.ExtensionContext,
    deps: {
        addToRestore: (key: string, fsPath: string) => Promise<void> | void;
        removeFromRestore: (key: string, fsPath: string) => Promise<void> | void;
        RESTORE_BLOCKLY_KEY: string;
        updateP5WebviewTabContext: () => void;
        notifyKidsModeFocus?: (docUri: string | undefined, isActive: boolean) => void;
        notifyPanelDisposed?: (docUri: string | undefined) => void;
    }
): BlocklyApi {
    // Track all open Blockly panels and lookups by file path and document uri
    const allBlocklyPanels = new Set<vscode.WebviewPanel>();
    const blocklyPanelsByPath = new Map<string, Set<vscode.WebviewPanel>>();
    const blocklyPanelForDocument = new Map<string, vscode.WebviewPanel>();
    const ignoreDocumentChangeForBlockly = new Set<string>();
    const workspaceDebounceTimers = new Map<string, Timeout>();
    const blocklyLineMapForDocument = new Map<string, Array<{ line: number; blockId: string }>>();
    const readyBlocklyPanels = new WeakSet<vscode.WebviewPanel>();
    const pendingWorkspaceForPanel = new WeakMap<vscode.WebviewPanel, string>();

    function normalizeFsPath(p: string | undefined | null): string {
        try {
            if (!p) return '';
            let n = path.normalize(p);
            if (process.platform === 'win32') n = n.toLowerCase();
            return n;
        } catch {
            return String(p || '');
        }
    }

    function queueWorkspaceLoad(panel: vscode.WebviewPanel, workspaceJson: string) {
        if (!workspaceJson) return;
        if (readyBlocklyPanels.has(panel)) {
            try { sendBlockly(panel, { type: 'loadWorkspace', workspace: workspaceJson }); } catch { }
        } else {
            pendingWorkspaceForPanel.set(panel, workspaceJson);
        }
    }

    function addPanelForPath(map: Map<string, Set<vscode.WebviewPanel>>, fsPath: string, panel: vscode.WebviewPanel) {
        const key = normalizeFsPath(fsPath);
        if (!map.has(key)) map.set(key, new Set());
        map.get(key)!.add(panel);
    }
    function removePanelForPath(map: Map<string, Set<vscode.WebviewPanel>>, fsPath: string, panel: vscode.WebviewPanel) {
        const key = normalizeFsPath(fsPath);
        if (!map.has(key)) return;
        const set = map.get(key)!;
        set.delete(panel);
        if (set.size === 0) map.delete(key);
    }

    function sidecarPathForFile(filePath: string) {
        try {
            const dir = path.dirname(filePath);
            const base = path.basename(filePath);
            const sidecarDir = path.join(dir, '.blockly');
            const sidecarName = base + '.blockly';
            return path.join(sidecarDir, sidecarName);
        } catch (e) {
            return null;
        }
    }
    function removeSidecarDirIfEmpty(sidePath: string | null) {
        try {
            if (!sidePath) return;
            const dir = path.dirname(sidePath);
            if (!fs.existsSync(dir)) return;
            const files = fs.readdirSync(dir);
            if (files.length === 0) {
                try { fs.rmdirSync(dir); } catch { /* ignore */ }
            }
        } catch { /* ignore */ }
    }

    function getNonce() {
        let text = '';
        const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        for (let i = 0; i < 32; i++) {
            text += possible.charAt(Math.floor(Math.random() * possible.length));
        }
        return text;
    }

    function extractEmbeddedWorkspaceFromCode(code: string): string | null {
        if (!code) return null;
        try {
            const m = code.match(/\/\*@BlocklyWorkspace\s*([\s\S]*?)\*\//);
            if (m && m[1]) return m[1].trim();
        } catch { }
        return null;
    }

    function buildBlocklyHtml(panel: vscode.WebviewPanel): string {
        const webview = panel.webview;
        const nonce = getNonce();
        const exampleRoot = vscode.Uri.file(path.join(context.extensionPath, 'blockly'));
        const indexCss = webview.asWebviewUri(vscode.Uri.file(path.join(exampleRoot.fsPath, 'index.css')));
        const toolboxJs = webview.asWebviewUri(vscode.Uri.file(path.join(exampleRoot.fsPath, 'toolbox.js')));
        const blocksJs = webview.asWebviewUri(vscode.Uri.file(path.join(exampleRoot.fsPath, 'blocks.js')));
        const generatorsJs = webview.asWebviewUri(vscode.Uri.file(path.join(exampleRoot.fsPath, 'generators.js')));
        const appJs = webview.asWebviewUri(vscode.Uri.file(path.join(exampleRoot.fsPath, 'app.js')));
        const autoBlocksJs = webview.asWebviewUri(vscode.Uri.file(path.join(exampleRoot.fsPath, 'p5_autoblocks.js')));

        const vendorBlocklyRoot = path.join(context.extensionPath, 'vendor', 'blockly');
        const hasLocalBlockly = (() => {
            try {
                return fs.existsSync(path.join(vendorBlocklyRoot, 'blockly_compressed.js')) &&
                    fs.existsSync(path.join(vendorBlocklyRoot, 'blocks_compressed.js')) &&
                    fs.existsSync(path.join(vendorBlocklyRoot, 'javascript_compressed.js')) &&
                    fs.existsSync(path.join(vendorBlocklyRoot, 'msg', 'en.js'));
            } catch { return false; }
        })();
        const blkCore = hasLocalBlockly
            ? webview.asWebviewUri(vscode.Uri.file(path.join(vendorBlocklyRoot, 'blockly_compressed.js'))).toString()
            : 'https://unpkg.com/blockly/blockly_compressed.js';
        const blkBlocks = hasLocalBlockly
            ? webview.asWebviewUri(vscode.Uri.file(path.join(vendorBlocklyRoot, 'blocks_compressed.js'))).toString()
            : 'https://unpkg.com/blockly/blocks_compressed.js';
        const blkJsGen = hasLocalBlockly
            ? webview.asWebviewUri(vscode.Uri.file(path.join(vendorBlocklyRoot, 'javascript_compressed.js'))).toString()
            : 'https://unpkg.com/blockly/javascript_compressed.js';
        const blkMsgEn = hasLocalBlockly
            ? webview.asWebviewUri(vscode.Uri.file(path.join(vendorBlocklyRoot, 'msg', 'en.js'))).toString()
            : 'https://unpkg.com/blockly/msg/en.js';

        // Load allowlist and extra categories from assets/<version>/blockly_categories.json
        let allowedBlocksScript = '';
        let extraCategoriesScript = '';
        try {
            const selectedP5Version = cfg.getP5jsVersion();
            const versioned = path.join(context.extensionPath, 'assets', selectedP5Version, 'blockly_categories.json');
            const defaultFallback = path.join(context.extensionPath, 'assets', '1.11', 'blockly_categories.json');
            const kidsFallback = path.join(context.extensionPath, 'assets', '1.11', 'blockly_kids_categories.json');
            const legacy = path.join(context.extensionPath, 'blockly', 'blockly_categories.json');
            const preferKidsCategories = cfg.getBlocklyKidsMode();
            const candidates = preferKidsCategories
                ? [kidsFallback, versioned, defaultFallback, legacy]
                : [versioned, defaultFallback, legacy];
            const allowPath = candidates.find(candidate => candidate && fs.existsSync(candidate));
            if (allowPath) {
                const txt = fs.readFileSync(allowPath, 'utf8');
                try {
                    const obj = JSON.parse(txt);
                    const allowed = new Set<string>();
                    let extraCats: any[] = [];
                    if (obj && Array.isArray(obj.categories)) {
                        for (const cat of obj.categories) {
                            if (cat && Array.isArray(cat.blocks)) {
                                for (const b of cat.blocks) {
                                    if (typeof b === 'string' && b.trim()) {
                                        allowed.add(b);
                                    } else if (b && typeof b === 'object' && typeof b.type === 'string' && b.type.trim()) {
                                        allowed.add(b.type);
                                    }
                                }
                            }
                        }
                        extraCats = obj.categories;
                    }
                    const arr = Array.from(allowed);
                    allowedBlocksScript = `<script nonce="${nonce}">\nwindow.ALLOWED_BLOCKS = ${JSON.stringify(arr)};\n<\/script>`;
                    extraCategoriesScript = `<script nonce="${nonce}">\nwindow.EXTRA_TOOLBOX_CATEGORIES = ${JSON.stringify(extraCats)};\n<\/script>`;
                } catch { /* ignore */ }
            }
        } catch { /* ignore */ }

        function buildP5CategoryMap(): Record<string, string> {
            const map: Record<string, string> = {};
            try {
                const selectedP5Version = cfg.getP5jsVersion();
                const srcRoot = (
                    selectedP5Version === '1.11'
                        ? path.join(context.extensionPath, 'assets', '1.11', 'p5types', 'src')
                        : path.join(context.extensionPath, 'assets', selectedP5Version, 'p5types', 'src')
                );
                if (!fs.existsSync(srcRoot)) {
                    return map;
                }
                const topFolders = [
                    'color', 'core', 'data', 'dom', 'events', 'image', 'io', 'math', 'typography', 'utilities', 'webgl'
                ];
                const labelForFolder: Record<string, string> = {
                    color: 'Color', core: 'Core', data: 'Data', dom: 'DOM', events: 'Events', image: 'Image', io: 'IO',
                    math: 'Math', typography: 'Typography', utilities: 'Utilities', webgl: 'WebGL',
                };
                function parseP5InstanceMethodsFromDts(text: string): string[] {
                    const out = new Set<string>();
                    const ifaceIdx = text.indexOf('interface p5InstanceExtensions');
                    if (ifaceIdx >= 0) {
                        const tail = text.slice(ifaceIdx);
                        const braceStart = tail.indexOf('{');
                        if (braceStart >= 0) {
                            const body = tail.slice(braceStart + 1);
                            const rx = /\n\s*([a-zA-Z_][\w]*)\s*\(/g;
                            let m: RegExpExecArray | null;
                            while ((m = rx.exec(body))) {
                                const name = m[1];
                                if (!name || name === 'constructor') continue;
                                out.add(name);
                            }
                        }
                    }
                    return Array.from(out);
                }
                function addFile(filePath: string, label: string) {
                    try {
                        const text = fs.readFileSync(filePath, 'utf8');
                        const names = parseP5InstanceMethodsFromDts(text);
                        names.forEach(n => { if (!map[n]) map[n] = label; });
                    } catch { }
                }
                topFolders.forEach(folder => {
                    const abs = path.join(srcRoot, folder);
                    if (!fs.existsSync(abs)) return;
                    const label = labelForFolder[folder] || folder;
                    const entries = fs.readdirSync(abs);
                    entries.forEach(entry => {
                        const full = path.join(abs, entry);
                        const stat = fs.statSync(full);
                        if (stat.isDirectory()) {
                            let subLabel = label;
                            if (folder === 'core') {
                                if (entry.toLowerCase().includes('shape')) subLabel = 'Shape';
                                else if (entry.toLowerCase().includes('structure')) subLabel = 'Structure';
                                else if (entry.toLowerCase().includes('transform')) subLabel = 'Transform';
                                else if (entry.toLowerCase().includes('environment')) subLabel = 'Environment';
                                else if (entry.toLowerCase().includes('render')) subLabel = 'Rendering';
                                else if (entry.toLowerCase().includes('constants')) subLabel = 'Constants';
                            } else if (folder === 'webgl') {
                                subLabel = 'WebGL';
                            }
                            const subFiles = fs.readdirSync(full);
                            subFiles.forEach(f => { if (f.endsWith('.d.ts')) addFile(path.join(full, f), subLabel); });
                        } else if (entry.endsWith('.d.ts')) {
                            addFile(full, label);
                        }
                    });
                });
            } catch { }
            return map;
        }
        const p5CategoryMap = buildP5CategoryMap();

        function buildP5ParamData(): { paramMap: Record<string, string[]>; optionalMap: Record<string, boolean[]>; typeMap: Record<string, string[]> } {
            const paramMap: Record<string, string[]> = {};
            const optionalMap: Record<string, boolean[]> = {};
            const typeMap: Record<string, string[]> = {};
            try {
                const selectedP5Version = cfg.getP5jsVersion();
                const srcRoot = (
                    selectedP5Version === '1.11'
                        ? path.join(context.extensionPath, 'assets', '1.11', 'p5types', 'src')
                        : path.join(context.extensionPath, 'assets', selectedP5Version, 'p5types', 'src')
                );
                if (!fs.existsSync(srcRoot)) {
                    return { paramMap, optionalMap, typeMap };
                }
                const folders = ['color', 'core', 'data', 'dom', 'events', 'image', 'io', 'math', 'typography', 'utilities', 'webgl'];
                const dtsFiles: string[] = [];
                function collectDts(dir: string) {
                    if (!fs.existsSync(dir)) return;
                    const entries = fs.readdirSync(dir);
                    entries.forEach((e) => {
                        const full = path.join(dir, e);
                        const stat = fs.statSync(full);
                        if (stat.isDirectory()) collectDts(full);
                        else if (e.endsWith('.d.ts')) dtsFiles.push(full);
                    });
                }
                folders.forEach(f => collectDts(path.join(srcRoot, f)));
                const ifaceStart = /interface\s+p5InstanceExtensions\b/;
                const sigRx = /\n\s*([a-zA-Z_][\w]*)\s*\(([^)]*)\)\s*:/g;
                dtsFiles.forEach(file => {
                    try {
                        const text = fs.readFileSync(file, 'utf8');
                        const idx = text.search(ifaceStart);
                        if (idx < 0) return;
                        const part = text.slice(idx);
                        const braceStart = part.indexOf('{');
                        if (braceStart < 0) return;
                        const windowText = part.slice(braceStart + 1, part.indexOf('\n}', braceStart + 1) > 0 ? part.indexOf('\n}', braceStart + 1) : part.length);
                        let m: RegExpExecArray | null;
                        while ((m = sigRx.exec(windowText))) {
                            const name = m[1];
                            const paramsStr = m[2].trim();
                            if (!name) continue;
                            const params: string[] = [];
                            const opts: boolean[] = [];
                            const kinds: string[] = [];
                            if (paramsStr.length > 0) {
                                paramsStr.split(',').forEach(raw => {
                                    let p = raw.trim();
                                    const beforeColon = (p.split(':')[0] || '').trim();
                                    const wasOptional = /\?$/.test(beforeColon);
                                    if (!p) return;
                                    const eqIdx = p.indexOf('=');
                                    let preDefault = p;
                                    if (eqIdx >= 0) preDefault = p.slice(0, eqIdx).trim();
                                    const colonIdx = preDefault.indexOf(':');
                                    let typeAnn = '';
                                    if (colonIdx >= 0) {
                                        typeAnn = preDefault.slice(colonIdx + 1).trim();
                                        p = preDefault.slice(0, colonIdx).trim();
                                    } else {
                                        p = preDefault.trim();
                                    }
                                    p = p.replace(/^\.{3}/, '');
                                    p = p.replace(/\?$/, '');
                                    if (p && /^[a-zA-Z_][\w]*$/.test(p)) {
                                        params.push(p);
                                        opts.push(!!wasOptional);
                                        let kind = 'other';
                                        const t = (typeAnn || '').toLowerCase();
                                        if (/\bnumber\b/.test(t)) kind = 'number';
                                        else if (/\bstring\b/.test(t)) kind = 'string';
                                        else if (/\bboolean\b/.test(t)) kind = 'boolean';
                                        kinds.push(kind);
                                    }
                                });
                            }
                            const prev = paramMap[name];
                            if (!prev || (params && params.length > prev.length)) {
                                if (params && params.length) { paramMap[name] = params; optionalMap[name] = opts; typeMap[name] = kinds; }
                            }
                        }
                    } catch { }
                });
            } catch { }
            return { paramMap, optionalMap, typeMap };
        }
        const { paramMap: p5ParamMap, optionalMap: p5ParamOptionalMap, typeMap: p5ParamTypeMap } = buildP5ParamData();

        const csp = `default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' https: 'unsafe-eval'; font-src ${webview.cspSource} https:; connect-src https:; media-src https: ${webview.cspSource}`;

        const storageKey = panel.title.startsWith(BLOCKLY_PANEL_TITLE_PREFIX)
            ? 'blockly_' + encodeURIComponent(panel.title.slice(BLOCKLY_PANEL_TITLE_PREFIX.length))
            : 'blockly_default';

        let configuredBlocklyTheme = 'dark';
        try {
            configuredBlocklyTheme = cfg.resolveBlocklyTheme();
        } catch { }

        return `<!doctype html>
    <html>
        <head>
            <meta charset="utf-8" />
            <meta http-equiv="Content-Security-Policy" content="${csp}">
            <meta name="viewport" content="width=device-width, initial-scale=1" />
            <title>Blockly</title>
            <link rel="stylesheet" href="${indexCss}" />
    <script nonce="${nonce}" src="${blkCore}"></script>
    <script nonce="${nonce}" src="${blkBlocks}"></script>
    <script nonce="${nonce}" src="${blkJsGen}"></script>
    <script nonce="${nonce}" src="${blkMsgEn}"></script>
        </head>
        <body>
            <div id="pageContainer">
                <div id="outputPane">
                    <pre id="generatedCode"><code></code></pre>
                    <div id="output"></div>
                </div>
                <div id="blocklyWrapper">
                    <div id="blocklyDiv"></div>
                    <button id="blocklyRefreshBtn" type="button" aria-label="Refresh Blockly code" title="Refresh Blockly code"></button>
                </div>
            </div>

        <script nonce="${nonce}" src="${toolboxJs}"></script>
    ${allowedBlocksScript}
    ${extraCategoriesScript}
        <script nonce="${nonce}" src="${blocksJs}"></script>
        <script nonce="${nonce}" src="${generatorsJs}"></script>
        <script nonce="${nonce}">
    window.P5_CATEGORY_MAP = ${JSON.stringify(p5CategoryMap)};
    window.P5_PARAM_MAP = ${JSON.stringify(p5ParamMap)};
    window.P5_PARAM_OPTIONAL = ${JSON.stringify(p5ParamOptionalMap)};
    window.P5_PARAM_TYPE = ${JSON.stringify(p5ParamTypeMap)};
    window.BLOCKLY_STORAGE_KEY = ${JSON.stringify(storageKey)};
    window.BLOCKLY_THEME = ${JSON.stringify(configuredBlocklyTheme)};
    window.BLOCKLY_JSON_ONLY = true;
        </script>
        <script nonce="${nonce}" src="${autoBlocksJs}"></script>
            <script nonce="${nonce}" src="${appJs}"></script>
        </body>
        </html>`;
    }

    // Command to open a Blockly panel for the active editor
    context.subscriptions.push(
        vscode.commands.registerCommand('extension.open-blockly', async () => {
            // Gate feature to P5 projects by checking for a jsconfig.json configured for p5
            const hasP5Project = (() => {
                try {
                    const folders = vscode.workspace.workspaceFolders || [];
                    for (const folder of folders) {
                        const rootPath = folder.uri.fsPath;
                        const jsconfigPath = path.join(rootPath, 'jsconfig.json');
                        if (fs.existsSync(jsconfigPath)) {
                            try {
                                const raw = fs.readFileSync(jsconfigPath, 'utf8');
                                const parsed = JSON.parse(raw);
                                const projectType = typeof parsed?.projectType === 'string' ? parsed.projectType.toLowerCase() : '';
                                if (projectType === 'p5' || projectType === 'p5js') {
                                    return true;
                                }
                            } catch { /* ignore parse errors and keep checking */ }
                        }
                    }
                } catch { /* ignore workspace errors */ }
                return false;
            })();
            if (!hasP5Project) {
                vscode.window.showInformationMessage('Blockly requires a configured P5 workspace. Run "Setup new p5 project" first.');
                return;
            }
            const originatingEditor = vscode.window.activeTextEditor;
            if (!originatingEditor) {
                vscode.window.showWarningMessage('No active editor to open Blockly for.');
                return;
            }
            const doc = originatingEditor.document;
            const docUriObj = doc.uri;
            const docUri = docUriObj.toString();
            const docFsPath = doc.fileName;
            let backingDocument: vscode.TextDocument | undefined = doc;
            const findOpenDocument = () => {
                if (backingDocument && !backingDocument.isClosed) {
                    return backingDocument;
                }
                const existing = vscode.workspace.textDocuments.find(d => d.uri.toString() === docUri);
                if (existing && !existing.isClosed) {
                    backingDocument = existing;
                    return existing;
                }
                return undefined;
            };
            const ensureDocumentHandle = async (): Promise<vscode.TextDocument | undefined> => {
                const existing = findOpenDocument();
                if (existing) {
                    return existing;
                }
                try {
                    const reopened = await vscode.workspace.openTextDocument(docUriObj);
                    backingDocument = reopened;
                    return reopened;
                } catch {
                    return undefined;
                }
            };
            const text = doc.getText();
            const isEmpty = text.trim().length === 0;
            const sidecar = sidecarPathForFile(doc.fileName);
            const hasSidecar = !!(sidecar && fs.existsSync(sidecar));
            if (!isEmpty && !hasSidecar) {
                vscode.window.showInformationMessage('Blockly was not opened: The file must be empty or have a .blockly sidecar file to open.');
                return;
            }
            const existingPanel = blocklyPanelForDocument.get(docUri);
            if (existingPanel) {
                existingPanel.reveal(vscode.ViewColumn.Active);
                return;
            }
            const scriptName = path.basename(doc.fileName);
            const preferKidsLayout = cfg.getBlocklyKidsMode();
            // Place Blockly in the top-left group for kids mode, otherwise bottom row
            let targetColumn: vscode.ViewColumn = preferKidsLayout ? vscode.ViewColumn.One : vscode.ViewColumn.Active;
            if (preferKidsLayout) {
                try { await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup'); } catch { }
            } else {
                try {
                    await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
                    const before = vscode.window.tabGroups.activeTabGroup;
                    await vscode.commands.executeCommand('workbench.action.focusBelowGroup');
                    let after = vscode.window.tabGroups.activeTabGroup;
                    if (!after || (before && after.viewColumn === before.viewColumn)) {
                        try { await vscode.commands.executeCommand('workbench.action.newGroupBelow'); } catch { }
                        await vscode.commands.executeCommand('workbench.action.focusBelowGroup');
                        await new Promise(r => setTimeout(r, 100));
                        after = vscode.window.tabGroups.activeTabGroup;
                    }
                    if (after && typeof after.viewColumn === 'number') targetColumn = after.viewColumn as vscode.ViewColumn;
                } catch { }
            }

            const panel = vscode.window.createWebviewPanel(
                BLOCKLY_PANEL_VIEWTYPE,
                `${BLOCKLY_PANEL_TITLE_PREFIX}${scriptName}`,
                { viewColumn: targetColumn, preserveFocus: true },
                {
                    enableScripts: true,
                    retainContextWhenHidden: true,
                    localResourceRoots: [
                        vscode.Uri.file(path.join(context.extensionPath, 'blockly')),
                        vscode.Uri.file(path.join(context.extensionPath, 'vendor')),
                        vscode.Uri.file(path.join(context.extensionPath, 'assets')),
                        vscode.Uri.file(path.join(context.extensionPath, 'assets', '1.11')),
                        vscode.Uri.file(path.join(context.extensionPath, 'assets', cfg.getP5jsVersion()))
                    ]
                }
            );
            blocklyPanelForDocument.set(docUri, panel);
            (panel as any)._sketchFilePath = normalizeFsPath(doc.fileName);
            allBlocklyPanels.add(panel);
            addPanelForPath(blocklyPanelsByPath, doc.fileName, panel);
            try { await deps.addToRestore(deps.RESTORE_BLOCKLY_KEY, doc.fileName); } catch { }
            panel.onDidDispose(async () => {
                blocklyPanelForDocument.delete(docUri);
                allBlocklyPanels.delete(panel);
                try { removePanelForPath(blocklyPanelsByPath, (panel as any)._sketchFilePath || doc.fileName, panel); } catch { }
                try { await deps.removeFromRestore(deps.RESTORE_BLOCKLY_KEY, doc.fileName); } catch { }
                try { deps.notifyKidsModeFocus?.(docUri, false); } catch { }
                try { deps.notifyPanelDisposed?.(docUri); } catch { }
            });
            panel.onDidChangeViewState(() => {
                try { deps.updateP5WebviewTabContext(); } catch { }
                try { deps.notifyKidsModeFocus?.(docUri, panel.active); } catch { }
            });
            panel.webview.html = buildBlocklyHtml(panel);
            try { deps.notifyKidsModeFocus?.(docUri, panel.active); } catch { }
            try {
                const resolved = cfg.resolveBlocklyTheme();
                try { sendBlockly(panel, { type: 'setBlocklyTheme', theme: resolved }); } catch { }
            } catch { }

            // After ready, prefer sidecar workspace; fallback to embedded
            (async () => {
                try {
                    const filePath = doc.fileName;
                    const sidecar = sidecarPathForFile(filePath);
                    let workspaceContent: string | null = null;
                    if (sidecar && fs.existsSync(sidecar)) {
                        try {
                            const raw = fs.readFileSync(sidecar, 'utf8');
                            try {
                                const obj = JSON.parse(raw);
                                if (obj && obj.workspace) {
                                    workspaceContent = JSON.stringify(obj.workspace);
                                    if (Array.isArray(obj.lineMap)) {
                                        try { blocklyLineMapForDocument.set(docUri, obj.lineMap); } catch { }
                                    }
                                } else {
                                    workspaceContent = raw;
                                }
                            } catch { workspaceContent = raw; }
                        } catch { workspaceContent = null; }
                    }
                    if (!workspaceContent) {
                        const embedded = extractEmbeddedWorkspaceFromCode(text);
                        if (embedded) {
                            workspaceContent = embedded;
                            try {
                                const sidecarDir = path.dirname(sidecar!);
                                fs.mkdirSync(sidecarDir, { recursive: true });
                                try {
                                    const payload = { workspace: JSON.parse(workspaceContent) } as any;
                                    fs.writeFileSync(sidecar!, JSON.stringify(payload, null, 2), 'utf8');
                                } catch {
                                    fs.writeFileSync(sidecar!, workspaceContent, 'utf8');
                                }
                            } catch { }
                        }
                    }
                    if (workspaceContent) {
                        queueWorkspaceLoad(panel, workspaceContent);
                    }
                } catch { }
            })();

            registerBlocklyRouter(panel, async (msg: BlocklyToExtensionMessage) => {
                if (!msg) return;
                if (msg.type === 'blocklyRequestSave') {
                    try {
                        const targetDoc = !doc.isClosed ? doc : await ensureDocumentHandle();
                        if (targetDoc && !targetDoc.isClosed) {
                            await targetDoc.save();
                        } else {
                            await vscode.commands.executeCommand('workbench.action.files.save');
                        }
                    } catch {
                        try { await vscode.commands.executeCommand('workbench.action.files.save'); } catch { }
                    }
                    return;
                }
                if (msg.type === 'blocklyReady') {
                    readyBlocklyPanels.add(panel);
                    const pending = pendingWorkspaceForPanel.get(panel);
                    if (pending) {
                        queueWorkspaceLoad(panel, pending);
                        pendingWorkspaceForPanel.delete(panel);
                    }
                    return;
                }
                if (msg.type === 'blocklyGeneratedCode' && typeof msg.code === 'string') {
                    let wsObj: any = null;
                    try { if (msg.workspace && typeof msg.workspace === 'string') wsObj = JSON.parse(msg.workspace); } catch { wsObj = null; }
                    try { if (Array.isArray(msg.lineMap)) blocklyLineMapForDocument.set(docUri, msg.lineMap); } catch { }
                    const targetDoc = !doc.isClosed ? doc : await ensureDocumentHandle();
                    try {
                        const filePath = docFsPath;
                        const sidecar = sidecarPathForFile(filePath);
                        if (sidecar && msg.workspace && typeof msg.workspace === 'string') {
                            try {
                                const sidecarDir = path.dirname(sidecar);
                                fs.mkdirSync(sidecarDir, { recursive: true });
                                try {
                                    const payload: any = { workspace: wsObj || JSON.parse(msg.workspace) };
                                    if (Array.isArray(msg.lineMap)) payload.lineMap = msg.lineMap;
                                    fs.writeFileSync(sidecar, JSON.stringify(payload, null, 2), 'utf8');
                                } catch {
                                    fs.writeFileSync(sidecar, msg.workspace, 'utf8');
                                }
                            } catch { }
                        }
                        let finalCode = msg.code
                            .replace(/\/\*@BlocklyWorkspace[\s\S]*?\*\//g, '')
                            .replace(/\/\*@b:(?:'[^']+'|[^*]+)\*\//g, '');
                        if (finalCode.trim().length === 0) finalCode = '';
                        else if (!finalCode.endsWith('\n')) finalCode = finalCode + '\n';
                        if (targetDoc) {
                            ignoreDocumentChangeForBlockly.add(docUri);
                            const fullRange = new vscode.Range(
                                targetDoc.positionAt(0),
                                targetDoc.positionAt(targetDoc.getText().length)
                            );
                            const edit = new vscode.WorkspaceEdit();
                            edit.replace(targetDoc.uri, fullRange, finalCode);
                            await vscode.workspace.applyEdit(edit);
                            await targetDoc.save();
                        } else {
                            try { fs.writeFileSync(filePath, finalCode, 'utf8'); } catch { }
                        }
                    } catch { }
                    setTimeout(() => ignoreDocumentChangeForBlockly.delete(docUri), 300);
                }
            });
        })
    );

    // Forward embedded workspace to Blockly on document edits (with debounce)
    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(e => {
        try {
            const docUri = e.document.uri.toString();
            const panel = blocklyPanelForDocument.get(docUri);
            if (!panel) return;
            if (ignoreDocumentChangeForBlockly.has(docUri)) return;
            if (workspaceDebounceTimers.has(docUri)) clearTimeout(workspaceDebounceTimers.get(docUri)!);
            workspaceDebounceTimers.set(docUri, setTimeout(() => {
                (async () => {
                    try {
                        const txt = e.document.getText();
                        const filePath = e.document.fileName;
                        const sidecar = sidecarPathForFile(filePath);
                        let workspaceContent: string | null = null;
                        if (sidecar && fs.existsSync(sidecar)) {
                            try {
                                const raw = fs.readFileSync(sidecar, 'utf8');
                                try {
                                    const obj = JSON.parse(raw);
                                    if (obj && obj.workspace) {
                                        workspaceContent = JSON.stringify(obj.workspace);
                                        if (Array.isArray(obj.lineMap)) { try { blocklyLineMapForDocument.set(docUri, obj.lineMap); } catch { } }
                                    } else {
                                        workspaceContent = raw;
                                    }
                                } catch { workspaceContent = raw; }
                            } catch { workspaceContent = null; }
                        }
                        if (!workspaceContent) {
                            const embedded = extractEmbeddedWorkspaceFromCode(txt);
                            if (embedded) {
                                workspaceContent = embedded;
                                try {
                                    const sidecarDir = path.dirname(sidecar!);
                                    fs.mkdirSync(sidecarDir, { recursive: true });
                                    fs.writeFileSync(sidecar!, workspaceContent, 'utf8');
                                } catch { }
                            }
                        }
                        if (workspaceContent) {
                            queueWorkspaceLoad(panel, workspaceContent);
                        }
                    } catch { }
                })();
            }, 350));
        } catch { }
    }));

    // Keep sidecar files in sync on rename/delete
    context.subscriptions.push(vscode.workspace.onDidRenameFiles(async ev => {
        try {
            for (const r of ev.files) {
                const oldFs = r.oldUri.fsPath;
                const newFs = r.newUri.fsPath;
                const oldSide = sidecarPathForFile(oldFs);
                const newSide = sidecarPathForFile(newFs);
                if (oldSide && fs.existsSync(oldSide)) {
                    try {
                        const newDir = path.dirname(newSide!);
                        fs.mkdirSync(newDir, { recursive: true });
                        fs.copyFileSync(oldSide, newSide!);
                        try { fs.unlinkSync(oldSide); removeSidecarDirIfEmpty(oldSide); } catch { }
                    } catch { }
                }
            }
        } catch { }
    }));
    context.subscriptions.push(vscode.workspace.onDidDeleteFiles(async ev => {
        try {
            for (const u of ev.files) {
                const fsPath = u.fsPath;
                const sc = sidecarPathForFile(fsPath);
                if (sc && fs.existsSync(sc)) {
                    try { fs.unlinkSync(sc); removeSidecarDirIfEmpty(sc); } catch { }
                }
            }
        } catch { }
    }));

    // Theme updates from configuration and active color theme changes
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('P5Studio.blocklyTheme')) {
            try {
                const resolved = cfg.resolveBlocklyTheme();
                for (const [, panel] of blocklyPanelForDocument.entries()) {
                    try { sendBlockly(panel, { type: 'setBlocklyTheme', theme: resolved }); } catch { }
                }
            } catch { }
        }
    }));
    context.subscriptions.push(vscode.window.onDidChangeActiveColorTheme(theme => {
        try {
            if (cfg.getBlocklyTheme() === 'auto') {
                const resolved = cfg.resolveBlocklyTheme();
                for (const [, panel] of blocklyPanelForDocument.entries()) {
                    try { sendBlockly(panel, { type: 'setBlocklyTheme', theme: resolved }); } catch { }
                }
            }
        } catch { }
    }));

    // Command: Decouple Blockly sidecar from a file (delete the .blockly sidecar)
    context.subscriptions.push(
        vscode.commands.registerCommand('extension.decouple-blockly', async (fileUri?: vscode.Uri) => {
            try {
                // Prompt for a file if not invoked from the explorer
                if (!fileUri) {
                    const picked = await vscode.window.showOpenDialog({
                        canSelectFiles: true,
                        canSelectFolders: false,
                        canSelectMany: false,
                        openLabel: 'Select file to decouple from Blockly',
                    });
                    if (!picked || picked.length === 0) return;
                    fileUri = picked[0];
                }
                const fsPath = fileUri.fsPath;
                const side = sidecarPathForFile(fsPath);
                if (!side || !fs.existsSync(side)) {
                    vscode.window.showInformationMessage('No Blockly workspace sidecar found for this file.');
                    return;
                }
                const confirm = await vscode.window.showWarningMessage(
                    `Delete Blockly workspace sidecar for '${path.basename(fsPath)}'?`,
                    { modal: true },
                    'Delete'
                );
                if (confirm === 'Delete') {
                    try {
                        fs.unlinkSync(side);
                        try { removeSidecarDirIfEmpty(side); } catch { }
                        // Remove from restore list and dispose any open Blockly panels for this file
                        try { await deps.removeFromRestore(deps.RESTORE_BLOCKLY_KEY, fsPath); } catch { }
                        try { disposePanelsForFilePath(fsPath); } catch { }
                        vscode.window.showInformationMessage('Blockly workspace decoupled (sidecar deleted).');
                    } catch (e: any) {
                        vscode.window.showErrorMessage('Failed to delete sidecar: ' + (e?.message || e));
                    }
                }
            } catch (e: any) {
                vscode.window.showErrorMessage('Failed to decouple Blockly: ' + (e?.message || e));
            }
        })
    );

    // Public API for extension.ts
    function clearHighlight(docUri: string) {
        try {
            const panel = blocklyPanelForDocument.get(docUri);
            if (panel) sendBlockly(panel, { type: 'clearBlocklyHighlight' });
        } catch { }
    }
    function highlightForLine(docUri: string, line: number) {
        try {
            const panel = blocklyPanelForDocument.get(docUri);
            const mapping = blocklyLineMapForDocument.get(docUri);
            if (panel) { try { sendBlockly(panel, { type: 'clearBlocklyHighlight' }); } catch { } }
            if (panel && Array.isArray(mapping) && mapping.length > 0) {
                const sorted = [...mapping].filter(m => m && typeof m.line === 'number' && typeof m.blockId === 'string');
                if (!sorted.length) return;
                let closest = sorted[0];
                let bestDiff = Math.abs((closest.line || 0) - line);
                for (let i = 1; i < sorted.length; i++) {
                    const candidate = sorted[i];
                    const diff = Math.abs((candidate.line || 0) - line);
                    if (diff < bestDiff || (diff === bestDiff && (candidate.line || 0) < (closest.line || 0))) {
                        closest = candidate;
                        bestDiff = diff;
                    }
                }
                if (closest && closest.blockId) {
                    sendBlockly(panel, { type: 'highlightBlocklyBlock', blockId: closest.blockId });
                }
            }
        } catch { }
    }
    function disposePanelsForFilePath(fsPath: string) {
        const fsPathNormalized = normalizeFsPath(fsPath);
        try {
            const blkSet = blocklyPanelsByPath.get(fsPathNormalized);
            if (blkSet) { for (const p of Array.from(blkSet)) { try { p.dispose(); } catch { } } }
            for (const p of Array.from(allBlocklyPanels)) {
                try { const tag = normalizeFsPath((p as any)._sketchFilePath || ''); if (tag && tag === fsPathNormalized) { p.dispose(); } } catch { }
            }
        } catch { }
    }

    function disposeAllPanels() {
        try {
            for (const panel of Array.from(allBlocklyPanels)) {
                try { panel.dispose(); } catch { }
            }
        } catch { }
    }

    function revealPanelForDocUri(docUri: string, opts?: { preserveFocus?: boolean }): boolean {
        try {
            const panel = blocklyPanelForDocument.get(docUri);
            if (panel) {
                const preserveFocus = opts?.preserveFocus ?? true;
                panel.reveal(panel.viewColumn, preserveFocus);
                return true;
            }
        } catch { /* ignore */ }
        return false;
    }
    return { clearHighlight, highlightForLine, disposePanelsForFilePath, revealPanelForDocUri, disposeAllPanels };
}
