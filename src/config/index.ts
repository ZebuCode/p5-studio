function getLogWarningsToOutput(): boolean {
    try {
        return vscode.workspace.getConfiguration('P5Studio').get<boolean>('lint.logWarningsToOutput', true) === true;
    } catch { return true; }
}
import * as vscode from 'vscode';

export type StrictLevel = 'ignore' | 'warn' | 'block';

function getP5jsVersion(): string {
    try {
        return vscode.workspace.getConfiguration('P5Studio').get<string>('P5jsVersion', '1.11') || '1.11';
    } catch { return '1.11'; }
}

function getStepRunDelayMs(): number {
    try {
        return vscode.workspace.getConfiguration('P5Studio').get<number>('debug.stepRunDelayMs', 500);
    } catch { return 500; }
}

function getShowDebugButton(): boolean {
    try {
        return vscode.workspace.getConfiguration('P5Studio').get<boolean>('debug.ShowDebugButton', false) === true;
    } catch { return false; }
}

function getShowFPS(): boolean {
    try {
        return vscode.workspace.getConfiguration('P5Studio').get<boolean>('showFPS', false) === true;
    } catch { return false; }
}

function getDebounceDelay(): number {
    try {
        return vscode.workspace.getConfiguration('P5Studio').get<number>('debounceDelay', 250);
    } catch { return 250; }
}

function getLoopGuardEnabled(): boolean {
    try {
        return vscode.workspace.getConfiguration('P5Studio').get<boolean>('loopGuard.enabled', true) !== false;
    } catch { return true; }
}

function getLoopGuardMaxIterations(): number {
    try {
        const value = vscode.workspace.getConfiguration('P5Studio').get<number>('loopGuard.maxIterations', 4000);
        return (typeof value === 'number' && value > 0) ? value : 4000;
    } catch { return 4000; }
}

function getLoopGuardMaxTimeMs(): number {
    try {
        const value = vscode.workspace.getConfiguration('P5Studio').get<number>('loopGuard.maxTimeMs', 250);
        return (typeof value === 'number' && value > 0) ? value : 250;
    } catch { return 250; }
}

function getVariablePanelDebounceDelay(): number {
    try {
        return vscode.workspace.getConfiguration('P5Studio').get<number>('variablePanelDebounceDelay', 500);
    } catch { return 500; }
}

function getEditorFontSize(): number {
    try {
        return vscode.workspace.getConfiguration('P5Studio').get<number>('editorFontSize', 14);
    } catch { return 14; }
}

function getReloadWhileTyping(): boolean {
    try {
        return vscode.workspace.getConfiguration('P5Studio').get<boolean>('reloadWhileTyping', true) === true;
    } catch { return true; }
}

function getReloadOnSave(): boolean {
    try {
        return vscode.workspace.getConfiguration('P5Studio').get<boolean>('reloadOnSave', true) === true;
    } catch { return true; }
}

function getStrictLevel(kind: 'Semicolon' | 'Undeclared' | 'NoVar' | 'LooseEquality'): StrictLevel {
    const cfg = vscode.workspace.getConfiguration('P5Studio');
    const key = `lint.Strict${kind}Warning` as const;
    let level = cfg.get<string>(key, 'warn') as StrictLevel;
    const valid = level === 'ignore' || level === 'warn' || level === 'block';
    if (!valid) level = 'warn';
    try { if (level) return level; } catch { }
    const enable = cfg.get<boolean>(
        kind === 'Semicolon' ? 'enableSemicolonWarning' :
            kind === 'Undeclared' ? 'enableUndeclaredWarning' :
                kind === 'NoVar' ? 'enableNoVarWarning' : 'enableLooseEqualityWarning', true);
    const block = cfg.get<boolean>(
        kind === 'Semicolon' ? 'BlockOnSemicolon' :
            kind === 'Undeclared' ? 'BlockOnUndeclared' :
                kind === 'NoVar' ? 'BlockOnNoVar' : 'BlockOnLooseEquality', true);
    if (!enable) return 'ignore';
    return block ? 'block' : 'warn';
}

function getOscConfig() {
    const cfg = vscode.workspace.getConfiguration('P5Studio');
    return {
        localAddress: cfg.get<string>('osc.oscLocalAddress', '127.0.0.1') || '127.0.0.1',
        localPort: cfg.get<number>('osc.oscLocalPort', 57121) || 57121,
        remoteAddress: cfg.get<string>('osc.oscRemoteAddress', '127.0.0.1') || '127.0.0.1',
        remotePort: cfg.get<number>('osc.oscRemotePort', 57122) || 57122,
    };
}

function getSingleP5Panel(): boolean {
    try {
        return vscode.workspace.getConfiguration('P5Studio').get<boolean>('SingleP5Panel', false) === true;
    } catch { return false; }
}

function getBlocklyTheme(): string {
    try {
        return vscode.workspace.getConfiguration('P5Studio').get<string>('blockly.blocklyTheme', 'dark') || 'dark';
    } catch { return 'dark'; }
}

function resolveBlocklyTheme(): string {
    try {
        const t = getBlocklyTheme();
        if (t === 'auto') {
            return vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark ? 'dark' : 'light';
        }
        return t || 'dark';
    } catch { return 'dark'; }
}

function getBlocklyKidsMode(): boolean {
    try {
        return vscode.workspace.getConfiguration('P5Studio').get<boolean>('blockly.kidsMode', false) === true;
    } catch { return false; }
}

function getBlocklyEnabled(): boolean {
    try {
        return vscode.workspace.getConfiguration('P5Studio').get<boolean>('blockly.enableBlockly', true) !== false;
    } catch { return true; }
}

async function setReloadWhileTyping(value: boolean): Promise<void> {
    const config = vscode.workspace.getConfiguration('P5Studio');
    await config.update('reloadWhileTyping', !!value, vscode.ConfigurationTarget.Global);
}

async function setShowDebugButton(value: boolean): Promise<void> {
    const config = vscode.workspace.getConfiguration('P5Studio');
    await config.update('debug.ShowDebugButton', !!value, vscode.ConfigurationTarget.Global);
}

async function setReloadOnSave(value: boolean): Promise<void> {
    const config = vscode.workspace.getConfiguration('P5Studio');
    await config.update('reloadOnSave', !!value, vscode.ConfigurationTarget.Global);
}

async function setShowFPS(value: boolean): Promise<void> {
    const config = vscode.workspace.getConfiguration('P5Studio');
    await config.update('showFPS', !!value, vscode.ConfigurationTarget.Global);
}

async function setShowSetupNotification(value: boolean): Promise<void> {
    const config = vscode.workspace.getConfiguration('P5Studio');
    await config.update('showSetupNotification', !!value, vscode.ConfigurationTarget.Global);
}

async function setEditorFontSize(value: number): Promise<void> {
    const config = vscode.workspace.getConfiguration('P5Studio');
    await config.update('editorFontSize', value, vscode.ConfigurationTarget.Global);
}

export const config = {
    getP5jsVersion,
    getStepRunDelayMs,
    getShowDebugButton,
    getShowFPS,
    getDebounceDelay,
    getLoopGuardEnabled,
    getLoopGuardMaxIterations,
    getLoopGuardMaxTimeMs,
    getVariablePanelDebounceDelay,
    getEditorFontSize,
    getReloadWhileTyping,
    getReloadOnSave,
    getBlockSketchOnWarning(): boolean {
        return vscode.workspace.getConfiguration('P5Studio').get<boolean>('lint.BlockSketchOnWarning', true) === true;
    },
    getShowSetupNotification(): boolean {
        return vscode.workspace.getConfiguration('P5Studio').get<boolean>('showSetupNotification', true) === true;
    },
    getBlocklyTheme,
    resolveBlocklyTheme,
    getBlocklyKidsMode,
    getBlocklyEnabled,
    getStrictLevel,
    getLogWarningsToOutput,
    getOscConfig,
    getSingleP5Panel,
    setReloadWhileTyping,
    setShowDebugButton,
    setReloadOnSave,
    setShowFPS,
    setShowSetupNotification,
    setEditorFontSize,
};
