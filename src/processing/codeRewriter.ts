import * as recast from 'recast';
import { RESERVED_GLOBALS, P5_NUMERIC_IDENTIFIERS, P5_EVENT_HANDLERS } from '../constants';
import type { VarControl } from '../types';

const SLIDER_DIRECTIVE_RE = /^\s*\/\/\s*@Slider\s*\(([^)]*)\)\s*$/i;

function countDecimalPlaces(raw: string): number {
    const trimmed = raw.trim();
    if (!trimmed.includes('.')) return 0;
    const expIdx = trimmed.toLowerCase().indexOf('e');
    const base = expIdx >= 0 ? trimmed.slice(0, expIdx) : trimmed;
    const dotIdx = base.indexOf('.');
    if (dotIdx === -1) return 0;
    return Math.max(0, base.length - dotIdx - 1);
}

function parseSliderDirective(line?: string): VarControl | undefined {
    if (!line) return undefined;
    const match = line.match(SLIDER_DIRECTIVE_RE);
    if (!match) return undefined;
    const rawArgs = match[1].split(',').map(part => part.trim()).filter(Boolean);
    if (rawArgs.length < 2) return undefined;
    const minRaw = rawArgs[0];
    const maxRaw = rawArgs[1];
    const minVal = Number(minRaw);
    const maxVal = Number(maxRaw);
    if (!Number.isFinite(minVal) || !Number.isFinite(maxVal) || minVal === maxVal) {
        return undefined;
    }
    let [min, max] = minVal <= maxVal ? [minVal, maxVal] : [maxVal, minVal];
    let step: number | undefined;
    if (rawArgs[2]) {
        const explicitStep = Number(rawArgs[2]);
        if (Number.isFinite(explicitStep) && explicitStep > 0) {
            step = explicitStep;
        }
    }
    if (!step) {
        const decimals = Math.max(countDecimalPlaces(minRaw), countDecimalPlaces(maxRaw));
        step = decimals > 0 ? Number((Math.pow(10, -decimals)).toFixed(decimals)) : 1;
    }
    const span = Math.abs(max - min);
    if (!Number.isFinite(step) || step <= 0) {
        step = span > 0 ? span / 100 : 1;
    }
    if (span > 0 && step > span) {
        step = span;
    }
    return { kind: 'slider', min, max, step };
}

function createSliderLookup(code: string): (node: any) => VarControl | undefined {
    const lines = code.split(/\r?\n/);
    return (node: any): VarControl | undefined => {
        const locLine = node && node.loc && node.loc.start && typeof node.loc.start.line === 'number'
            ? node.loc.start.line
            : undefined;
        if (typeof locLine !== 'number') return undefined;
        let idx = locLine - 2;
        while (idx >= 0) {
            const rawLine = lines[idx];
            if (typeof rawLine !== 'string') return undefined;
            if (rawLine.trim() === '') {
                idx--;
                continue;
            }
            return parseSliderDirective(rawLine);
        }
        return undefined;
    };
}

// Extract top-level global variables and detect conflicts with reserved names
export function extractGlobalVariablesWithConflicts(code: string): { globals: { name: string, value: any, type: string, control?: VarControl }[], conflicts: string[] } {
    const acorn = require('acorn');
    const ast = recast.parse(code, {
        parser: {
            parse: (src: string) => acorn.parse(src, {
                ecmaVersion: 2020,
                sourceType: 'script',
                locations: true,
            }),
        },
    });
    const globals: { name: string, value: any, type: string, control?: VarControl }[] = [];
    const conflicts: string[] = [];
    const sliderLookup = createSliderLookup(code);
    function extractFromDecls(decls: any[]) {
        for (const decl of decls) {
            if (decl.id && decl.id.name) {
                let value = undefined;
                let type = 'other';
                if (decl.init && decl.init.type === 'Literal') {
                    value = decl.init.value;
                    type = typeof value;
                } else if (decl.init && decl.init.type === 'ArrayExpression') {
                    try {
                        const arr = Function('Array', `return (${recast.print(decl.init).code});`)(Array);
                        if (Array.isArray(arr)) { value = arr; type = 'array'; } else { value = undefined; type = 'other'; }
                    } catch { value = undefined; type = 'other'; }
                } else if (decl.init && decl.init.type === 'UnaryExpression' && decl.init.argument.type === 'Literal') {
                    value = decl.init.operator === '-' ? -decl.init.argument.value : decl.init.argument.value;
                    type = typeof value;
                } else if (decl.init && decl.init.type === 'Identifier') {
                    value = decl.init.name;
                    type = P5_NUMERIC_IDENTIFIERS.has(decl.init.name) ? 'number' : 'other';
                } else if (decl.init && decl.init.type === 'CallExpression') {
                    value = 0; type = 'number';
                } else if (decl.init) {
                    try {
                        const safeGlobals = { Math, Number, String, Boolean, Array, Object };
                        const evaluated = Function(...Object.keys(safeGlobals), `return (${recast.print(decl.init).code});`)
                            (...Object.values(safeGlobals));
                        if (Array.isArray(evaluated)) {
                            value = evaluated; type = 'array';
                        } else {
                            value = evaluated; type = typeof evaluated;
                            if (!['number', 'string', 'boolean', 'array'].includes(type)) { value = undefined; type = 'other'; }
                        }
                    } catch { value = undefined; type = 'other'; }
                }
                const control = type === 'number' ? sliderLookup(decl) : undefined;
                if (RESERVED_GLOBALS.has(decl.id.name)) {
                    conflicts.push(decl.id.name);
                } else {
                    globals.push({ name: decl.id.name, value, type, control });
                }
            }
        }
    }
    recast.types.visit(ast, {
        visitVariableDeclaration(path) {
            if (path.parentPath && path.parentPath.value.type === 'Program') {
                extractFromDecls(path.value.declarations);
            }
            this.traverse(path);
        }
    });
    if (ast.program && Array.isArray(ast.program.body)) {
        for (const node of ast.program.body) {
            if (node.type === 'VariableDeclaration') { extractFromDecls(node.declarations); }
        }
    }
    return { globals, conflicts };
}

// Extract top-level global variables, excluding reserved names
export function extractGlobalVariables(code: string): { name: string, value: any, type: string, control?: VarControl }[] {
    const acorn = require('acorn');
    const ast = recast.parse(code, {
        parser: {
            parse: (src: string) => acorn.parse(src, {
                ecmaVersion: 2020,
                sourceType: 'script',
                locations: true,
            }),
        },
    });
    const globals: { name: string, value: any, type: string, control?: VarControl }[] = [];
    const sliderLookup = createSliderLookup(code);
    function extractFromDecls(decls: any[]) {
        for (const decl of decls) {
            if (decl.id && decl.id.name) {
                let value = undefined;
                let type = 'other';
                if (decl.init && decl.init.type === 'Literal') {
                    value = decl.init.value; type = typeof value;
                } else if (decl.init && decl.init.type === 'ArrayExpression') {
                    try {
                        const arr = Function('Array', `return (${recast.print(decl.init).code});`)(Array);
                        if (Array.isArray(arr)) { value = arr; type = 'array'; } else { value = undefined; type = 'other'; }
                    } catch { value = undefined; type = 'other'; }
                } else if (decl.init && decl.init.type === 'UnaryExpression' && decl.init.argument.type === 'Literal') {
                    value = decl.init.operator === '-' ? -decl.init.argument.value : decl.init.argument.value; type = typeof value;
                } else if (decl.init && decl.init.type === 'Identifier') {
                    value = decl.init.name; type = P5_NUMERIC_IDENTIFIERS.has(decl.init.name) ? 'number' : 'other';
                } else if (decl.init && decl.init.type === 'CallExpression') {
                    value = undefined; type = 'number';
                } else if (decl.init) {
                    try {
                        const safeGlobals = { Math, Number, String, Boolean, Array, Object };
                        const evaluated = Function(...Object.keys(safeGlobals), `return (${recast.print(decl.init).code});`)
                            (...Object.values(safeGlobals));
                        if (Array.isArray(evaluated)) {
                            value = evaluated; type = 'array';
                        } else {
                            value = evaluated; type = typeof evaluated;
                            if (!['number', 'string', 'boolean', 'array'].includes(type)) { value = undefined; type = 'other'; }
                        }
                    } catch { value = undefined; type = 'other'; }
                }
                const control = type === 'number' ? sliderLookup(decl) : undefined;
                globals.push({ name: decl.id.name, value, type, control });
            }
        }
    }
    recast.types.visit(ast, {
        visitVariableDeclaration(path) {
            if (path.parentPath && path.parentPath.value.type === 'Program') {
                extractFromDecls(path.value.declarations);
            }
            this.traverse(path);
        }
    });
    if (ast.program && Array.isArray(ast.program.body)) {
        for (const node of ast.program.body) {
            if (node.type === 'VariableDeclaration') { extractFromDecls(node.declarations); }
        }
    }
    return globals.filter(g => !RESERVED_GLOBALS.has(g.name));
}

// Rewrite user code so global variables are attached to window and event handlers are guarded
export function rewriteUserCodeWithWindowGlobals(code: string, globals: { name: string, value?: any }[]): string {
    if (!globals.length) return code;
    // Stepping helpers are managed by instrumentation and must not be treated as user globals.
    const STEPPING_HELPERS = new Set([
        '__highlight',
        '__clearHighlight',
        '__waitStep',
        '__liveP5StepAdvance',
        '__liveP5StepResolve'
    ]);
    const acorn = require('acorn');
    const ast = recast.parse(code, { parser: { parse: (src: string) => acorn.parse(src, { ecmaVersion: 2020, sourceType: 'script' }) } });
    const globalNames = new Set(globals.map(g => g.name).filter(n => !STEPPING_HELPERS.has(n)));
    const declarationKinds = new Map<string, string>();
    const globalsWithNoInit = new Set<string>();
    const programBody = (ast as any).program.body;
    const newBody: any[] = [];
    let setupFound = false;
    const globalAssignments: any[] = [];

    // Collect assignments for globals with initializers
    for (const stmt of programBody) {
        if (stmt.type === 'VariableDeclaration') {
            for (const decl of stmt.declarations) {
                if (stmt.kind !== 'const' && decl.id && decl.id.name && globalNames.has(decl.id.name) && decl.init) {
                    globalAssignments.push(recast.types.builders.expressionStatement(recast.types.builders.assignmentExpression('=', recast.types.builders.identifier(decl.id.name), decl.init)));
                }
            }
        }
    }

    // Insert window.<global> = undefined for globals that have initializers only
    for (const g of globals.filter(g => !STEPPING_HELPERS.has(g.name))) {
        // Only assign window.<name> = undefined if the original declaration had an initializer
        const hadInit = programBody.some(stmt => stmt.type === 'VariableDeclaration' && stmt.kind !== 'const' && stmt.declarations.some((decl: any) => decl.id && decl.id.name === g.name && decl.init));
        if (hadInit) {
            newBody.push(recast.types.builders.expressionStatement(
                recast.types.builders.assignmentExpression('=',
                    recast.types.builders.memberExpression(recast.types.builders.identifier('window'), recast.types.builders.identifier(g.name), false),
                    recast.types.builders.identifier('undefined'))));
        }
    }

    for (let i = 0; i < programBody.length; i++) {
        let stmt = programBody[i];
        if (stmt.type === 'VariableDeclaration') {
            for (const decl of stmt.declarations) {
                if (decl.id && decl.id.name) {
                    if (decl.init == null) {
                        globalsWithNoInit.add(decl.id.name);
                    }
                    declarationKinds.set(decl.id.name, stmt.kind);
                }
            }
            stmt.declarations = stmt.declarations.map((decl: any) => {
                if (stmt.kind !== 'const' && decl.id && decl.id.name && globalNames.has(decl.id.name)) { return Object.assign({}, decl, { init: null }); }
                return decl;
            });
            if (stmt.kind === 'let' && stmt.declarations.some((decl: any) => decl.id && decl.id.name && globalNames.has(decl.id.name))) {
                stmt = Object.assign({}, stmt, { kind: 'var' });
            }
            newBody.push(stmt);
            for (const decl of stmt.declarations) {
                if (decl.id && decl.id.name && globalNames.has(decl.id.name)) {
                    if (stmt.kind === 'const') {
                        newBody.push(recast.types.builders.expressionStatement(
                            recast.types.builders.callExpression(
                                recast.types.builders.memberExpression(
                                    recast.types.builders.identifier('Object'),
                                    recast.types.builders.identifier('defineProperty'),
                                    false
                                ),
                                [
                                    recast.types.builders.identifier('window'),
                                    recast.types.builders.literal(decl.id.name),
                                    recast.types.builders.objectExpression([
                                        recast.types.builders.property('init', recast.types.builders.identifier('configurable'), recast.types.builders.literal(true)),
                                        recast.types.builders.property('init', recast.types.builders.identifier('enumerable'), recast.types.builders.literal(true)),
                                        recast.types.builders.property(
                                            'init',
                                            recast.types.builders.identifier('get'),
                                            recast.types.builders.functionExpression(
                                                null,
                                                [],
                                                recast.types.builders.blockStatement([
                                                    recast.types.builders.returnStatement(recast.types.builders.identifier(decl.id.name))
                                                ])
                                            )
                                        ),
                                        recast.types.builders.property(
                                            'init',
                                            recast.types.builders.identifier('set'),
                                            recast.types.builders.functionExpression(
                                                null,
                                                [recast.types.builders.identifier('_value')],
                                                recast.types.builders.blockStatement([
                                                    recast.types.builders.throwStatement(
                                                        recast.types.builders.newExpression(
                                                            recast.types.builders.identifier('TypeError'),
                                                            [recast.types.builders.literal('Assignment to constant variable.')]
                                                        )
                                                    )
                                                ])
                                            )
                                        )
                                    ])
                                ]
                            )
                        ));
                    } else {
                        newBody.push(recast.types.builders.expressionStatement(recast.types.builders.assignmentExpression('=', recast.types.builders.memberExpression(recast.types.builders.identifier('window'), recast.types.builders.identifier(decl.id.name), false), recast.types.builders.identifier(decl.id.name))));
                    }
                }
            }
            continue;
        }

        if (stmt.type === 'FunctionDeclaration' && stmt.id && stmt.id.name === 'setup' && stmt.body && stmt.body.body) {
            setupFound = true;
            const originalStmt: any = stmt;
            const setupStmts = [...stmt.body.body];
            // Initialize globals before user setup code so values are available to createCanvas(...)
            const newSetupBody = [...globalAssignments, ...setupStmts];
            newSetupBody.push(recast.types.builders.expressionStatement(
                recast.types.builders.assignmentExpression('=',
                    recast.types.builders.memberExpression(recast.types.builders.identifier('window'), recast.types.builders.identifier('_p5SetupDone'), false),
                    recast.types.builders.literal(true))));
            let newFn = recast.types.builders.functionDeclaration(stmt.id, stmt.params, recast.types.builders.blockStatement(newSetupBody));
            (newFn as any).async = !!(originalStmt as any).async;
            stmt = newFn as any;
            newBody.push(stmt);
            continue;
        }

        if (stmt.type === 'FunctionDeclaration' && stmt.id && P5_EVENT_HANDLERS.includes(stmt.id.name)) {
            const originalStmt: any = stmt;
            const origBody = stmt.body.body;
            const guardedBody = [recast.types.builders.ifStatement(recast.types.builders.unaryExpression('!', recast.types.builders.memberExpression(recast.types.builders.identifier('window'), recast.types.builders.identifier('_p5SetupDone'), false)), recast.types.builders.blockStatement([recast.types.builders.returnStatement(null)])), ...origBody];
            let newFn = recast.types.builders.functionDeclaration(stmt.id, stmt.params, recast.types.builders.blockStatement(guardedBody));
            (newFn as any).async = !!(originalStmt as any).async;
            stmt = newFn as any;
        }
        newBody.push(stmt);
    }

    if (!setupFound) {
        const setupBody = [...globalAssignments, recast.types.builders.expressionStatement(recast.types.builders.assignmentExpression('=', recast.types.builders.memberExpression(recast.types.builders.identifier('window'), recast.types.builders.identifier('_p5SetupDone'), false), recast.types.builders.literal(true)))];
        newBody.push(recast.types.builders.functionDeclaration(recast.types.builders.identifier('setup'), [], recast.types.builders.blockStatement(setupBody)));
    }

    (ast as any).program.body = newBody;

    function isFunctionParam(path: any): boolean {
        const parent = path.parentPath && path.parentPath.value;
        if (!parent) return false;
        if (parent.type === 'FunctionDeclaration' || parent.type === 'FunctionExpression' || parent.type === 'ArrowFunctionExpression') {
            return Array.isArray(parent.params) && parent.params.includes(path.value);
        }
        return false;
    }

    function isInBindingPattern(path: any): boolean {
        let p: any = path;
        while (p && p.parentPath) {
            const v = p.parentPath.value;
            if (!v) break;
            if (v.type === 'ObjectPattern' || v.type === 'ArrayPattern' || v.type === 'RestElement' || v.type === 'AssignmentPattern') return true;
            if (v.type === 'VariableDeclarator' && p.name === 'id') return true;
            if (v.type === 'FunctionDeclaration' || v.type === 'FunctionExpression' || v.type === 'ArrowFunctionExpression') {
                if (Array.isArray(v.params)) {
                    for (const prm of v.params) {
                        if (prm === p.value) return true;
                        // If parameters are patterns, treat as binding positions
                        if (prm && (prm.type === 'ObjectPattern' || prm.type === 'ArrayPattern' || prm.type === 'RestElement' || prm.type === 'AssignmentPattern')) return true;
                    }
                }
                return false;
            }
            p = p.parentPath;
        }
        return false;
    }

    function isObjectPropertyKey(path: any): boolean {
        const parent = path.parentPath && path.parentPath.value;
        return !!(parent && parent.type === 'Property' && parent.key === path.value && !parent.computed);
    }

    function collectBoundNamesFromPattern(pattern: any, out: Set<string>) {
        if (!pattern) return;
        if (pattern.type === 'Identifier') { out.add(pattern.name); return; }
        if (pattern.type === 'ObjectPattern') {
            for (const prop of (pattern.properties || [])) {
                if (!prop) continue;
                if (prop.type === 'Property') collectBoundNamesFromPattern(prop.value, out);
                else if (prop.type === 'RestElement') collectBoundNamesFromPattern(prop.argument, out);
            }
            return;
        }
        if (pattern.type === 'ArrayPattern') {
            for (const el of (pattern.elements || [])) {
                if (!el) continue;
                if (el.type === 'RestElement') collectBoundNamesFromPattern(el.argument, out);
                else collectBoundNamesFromPattern(el, out);
            }
            return;
        }
        if (pattern.type === 'RestElement') { collectBoundNamesFromPattern(pattern.argument, out); return; }
        if (pattern.type === 'AssignmentPattern') { collectBoundNamesFromPattern(pattern.left, out); return; }
    }

    function isShadowedByParams(path: any, name: string): boolean {
        // Find nearest function ancestor and check its parameter bindings
        let p: any = path;
        while (p && p.parentPath) {
            const v = p.parentPath.value;
            if (!v) break;
            if (v.type === 'FunctionDeclaration' || v.type === 'FunctionExpression' || v.type === 'ArrowFunctionExpression') {
                const bound = new Set<string>();
                if (Array.isArray(v.params)) {
                    for (const prm of v.params) {
                        collectBoundNamesFromPattern(prm, bound);
                    }
                }
                return bound.has(name);
            }
            p = p.parentPath;
        }
        return false;
    }

    recast.types.visit(ast, {
        visitIdentifier(path) {
            const name = (path.value as any).name;
            const isGlobalName = (globalNames as any).has(name);
            const isMemberOfWindow = !!(path.parentPath && path.parentPath.value && path.parentPath.value.type === 'MemberExpression' && (path.parentPath.value as any).property === path.value && (path.parentPath.value as any).object.type === 'Identifier' && (path.parentPath.value as any).object.name === 'window');
            const isDeclarationId = !!(path.parentPath && path.parentPath.value && (((path.parentPath.value as any).type === 'VariableDeclarator' && (path.parentPath.value as any).id === path.value) || ((path.parentPath.value as any).type === 'FunctionDeclaration' && (path.parentPath.value as any).id === path.value) || ((path.parentPath.value as any).type === 'FunctionExpression' && (path.parentPath.value as any).id === path.value) || ((path.parentPath.value as any).type === 'ClassDeclaration' && (path.parentPath.value as any).id === path.value)));
            const isThisMemberWindowProperty = !!(path.parentPath && path.parentPath.value && path.parentPath.value.type === 'MemberExpression' && (path.parentPath.value as any).property === path.value && (((path.parentPath.value as any).object.type === 'ThisExpression') || ((path.parentPath.value as any).object.type === 'MemberExpression' && (path.parentPath.value as any).object.object && (path.parentPath.value as any).object.object.type === 'ThisExpression' && (path.parentPath.value as any).object.property && (path.parentPath.value as any).object.property.name === 'window')));
            const isNonComputedProperty = !!(path.parentPath && path.parentPath.value && path.parentPath.value.type === 'MemberExpression' && (path.parentPath.value as any).property === path.value && !(path.parentPath.value as any).computed);
            const bindingScope = (path.scope && typeof path.scope.lookup === 'function') ? path.scope.lookup(name) : null;
            const isLocallyBound = !!(bindingScope && !bindingScope.isGlobal);
            // Do not rewrite identifiers that are parameters, binding patterns, shadowed names, or locally scoped helpers.
            if (isFunctionParam(path) || isInBindingPattern(path) || isShadowedByParams(path, name) || isLocallyBound || isNonComputedProperty || isObjectPropertyKey(path)) {
                this.traverse(path);
                return;
            }
            if (isGlobalName && !isMemberOfWindow && !isDeclarationId && !isThisMemberWindowProperty) {
                const declaredKind = declarationKinds.get(name);
                if (declaredKind !== 'const' && !globalsWithNoInit.has(name)) {
                    return recast.types.builders.memberExpression(recast.types.builders.identifier('window'), recast.types.builders.identifier(name), false);
                }
            }
            this.traverse(path);
        }
    });
    const rewritten = recast.print(ast).code;
    //try { console.log('REWRITTEN CODE:', rewritten); } catch { }
    return rewritten;
}
