import * as path from 'path';
import * as vscode from 'vscode';
import * as acorn from 'acorn';
import { getTime } from '../utils/helpers';
import {
    detectTopLevelInputs,
    hasNonTopInputUsage,
    preprocessTopLevelInputs,
    hasCachedInputsForKey,
    getCachedInputsForKey,
    TopInputItem,
} from './topInputs';
import {
    extractGlobalVariablesWithConflicts,
    extractGlobalVariables,
} from './codeRewriter';
import {
    wrapInSetupIfNeeded,
    formatSyntaxErrorMsg,
    getHiddenGlobalsByDirective,
    hasOnlySetup,
    findFirstTemplateLiteral,
    formatTemplateLiteralError,
} from './astHelpers';
import { instrumentRuntimeLineTracking } from './instrumentation';
import type { VarControl } from '../types';

export type ReloadReason = 'typing' | 'save' | 'command' | 'open' | undefined;

export interface SketchPrepGlobals {
    variables: Array<{ name: string; type: string; control?: VarControl; readonly?: boolean }>;
    readOnly: boolean;
}

export interface SketchPrepResult {
    ok: boolean;
    codeToInject: string;
    inputsOverlay?: TopInputItem[];
    syntaxErrorMsg?: string;
    runtimeErrorMsg?: string;
    reservedConflictMsg?: string;
    globals?: SketchPrepGlobals;
    blockOnLint?: boolean;
}

export interface LintBlockApi {
    hasSemicolonWarnings: (document: vscode.TextDocument) => { has: boolean };
    hasUndeclaredWarnings: (document: vscode.TextDocument) => { has: boolean };
    hasVarWarnings: (document: vscode.TextDocument) => { has: boolean };
    hasEqualityWarnings?: (document: vscode.TextDocument) => { has: boolean };
    getStrictLevel: (kind: 'Semicolon' | 'Undeclared' | 'NoVar' | 'LooseEquality') => 'ignore' | 'warn' | 'block';
}

export interface SketchPrepOptions {
    document: vscode.TextDocument;
    reason: ReloadReason;
    lint: LintBlockApi;
    allowInteractiveTopInputs: boolean;
}

export interface ValidateSourceResult {
    ok: boolean;
    code: string;
    syntaxErrorMsg?: string;
    reservedConflictMsg?: string;
}

export function validateSource(document: vscode.TextDocument, code?: string): ValidateSourceResult {
    const fileName = path.basename(document.fileName);
    if (typeof code !== 'string') {
        code = document.getText();
    }

    let globalsInfo: { globals: Array<{ name: string; type: string }>; conflicts: string[] };
    try {
        globalsInfo = extractGlobalVariablesWithConflicts(code);
    } catch {
        globalsInfo = { globals: [], conflicts: [] };
    }

    if (globalsInfo.conflicts.length > 0) {
        const msg = `${getTime()} [‼️SYNTAX ERROR in ${fileName}] Reserved variable name(s) used: ${globalsInfo.conflicts.join(', ')}`;
        const formatted = formatSyntaxErrorMsg(msg);
        return {
            ok: false,
            code: '',
            syntaxErrorMsg: formatted,
            reservedConflictMsg: formatted,
        };
    }

    try {
        acorn.parse(code, {
            ecmaVersion: 2020,
            sourceType: 'script',
            locations: true,
            allowReturnOutsideFunction: true,
            allowAwaitOutsideFunction: true,
            allowImportExportEverywhere: true,
        });
    } catch (err: any) {
        const reason = err && err.message ? err.message : 'Unknown syntax error';
        const msg = `${getTime()} [‼️SYNTAX ERROR in ${fileName}] ${reason}`;
        return {
            ok: false,
            code: '',
            syntaxErrorMsg: formatSyntaxErrorMsg(msg),
        };
    }

    return { ok: true, code };
}

export async function prepareSketch(opts: SketchPrepOptions): Promise<SketchPrepResult> {
    const { document, reason, lint } = opts;
    const fileName = path.basename(document.fileName);
    const originalCode = document.getText();
    let code = originalCode;

    const templateInfo = findFirstTemplateLiteral(originalCode);
    if (templateInfo) {
        const message = formatTemplateLiteralError(getTime, fileName, templateInfo);
        return {
            ok: false,
            codeToInject: '',
            runtimeErrorMsg: message,
        };
    }

    try {
        if (hasNonTopInputUsage(code)) {
            const friendly = 'inputPrompt() can only be used at the very top of the sketch to initialize a variable, e.g.: let a = inputPrompt(); ';
            return {
                ok: false,
                codeToInject: '',
                runtimeErrorMsg: `${getTime()} [‼️RUNTIME ERROR in ${fileName}] ${friendly}`,
            };
        }
    } catch {
        // fall through and let later syntax handling deal with it
    }

    let inputs: TopInputItem[] = [];
    try {
        inputs = detectTopLevelInputs(code);
    } catch {
        inputs = [];
    }

    const key = document.fileName;
    if (inputs.length > 0) {
        if (reason === 'save' || reason === 'command') {
            let itemsToShow = inputs;
            if (hasCachedInputsForKey(key, inputs)) {
                const cached = getCachedInputsForKey(key);
                if (cached) {
                    itemsToShow = inputs.map((it, i) => ({
                        varName: it.varName,
                        label: it.label,
                        defaultValue: typeof cached.values[i] !== 'undefined' ? cached.values[i] : it.defaultValue,
                    }));
                }
            }
            return { ok: false, codeToInject: '', inputsOverlay: itemsToShow };
        }

        if (reason === 'typing' && hasCachedInputsForKey(key, inputs)) {
            try {
                code = await preprocessTopLevelInputs(code, { key, interactive: false });
            } catch {
                // ignore and keep original code
            }
        }
    }

    const validation = validateSource(document, code);
    if (!validation.ok) {
        return {
            ok: false,
            codeToInject: '',
            syntaxErrorMsg: validation.syntaxErrorMsg,
            reservedConflictMsg: validation.reservedConflictMsg,
        };
    }
    code = validation.code;

    // Lint-based blocking
    const warnSemi = lint.hasSemicolonWarnings(document);
    const warnUnd = lint.hasUndeclaredWarnings(document);
    const warnVar = lint.hasVarWarnings(document);
    const warnEq = lint.hasEqualityWarnings ? lint.hasEqualityWarnings(document) : { has: false };
    const shouldBlock =
        (lint.getStrictLevel('Semicolon') === 'block' && warnSemi.has) ||
        (lint.getStrictLevel('Undeclared') === 'block' && warnUnd.has) ||
        (lint.getStrictLevel('NoVar') === 'block' && warnVar.has) ||
        (lint.getStrictLevel('LooseEquality') === 'block' && warnEq.has);

    if (shouldBlock) {
        return {
            ok: false,
            codeToInject: '',
            blockOnLint: true,
        };
    }

    // Track current sketch line at runtime so error reporting can show source lines.
    code = instrumentRuntimeLineTracking(code);

    // Only wrap if we get here with no errors
    code = wrapInSetupIfNeeded(code);

    // Globals snapshot for Variables panel
    let filteredGlobals: Array<{ name: string; type: string; control?: VarControl; readonly?: boolean }> = [];
    let readOnly = false;
    try {
        // Use originalCode for global extraction so variables that were moved inside setup (no-setup/no-draw) still appear
        const globalsInfo = extractGlobalVariablesWithConflicts(originalCode);
        filteredGlobals = globalsInfo.globals.filter(g => ['number', 'string', 'boolean', 'array'].includes(g.type));
        const hiddenSet = getHiddenGlobalsByDirective(originalCode);
        if (hiddenSet.size > 0) {
            filteredGlobals = filteredGlobals.filter(g => !hiddenSet.has(g.name));
        }
        readOnly = hasOnlySetup(originalCode);
    } catch {
        filteredGlobals = [];
        readOnly = false;
    }

    return {
        ok: true,
        codeToInject: code,
        globals: { variables: filteredGlobals, readOnly },
    };
}
