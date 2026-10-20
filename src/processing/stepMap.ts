import * as recast from 'recast';

export type StepPhase = 'top-level' | 'setup' | 'draw' | 'function';

export interface StepLoc {
    line: number;
    column: number;
    endLine: number;
    endColumn: number;
}

export interface StepTarget {
    id: number;
    phase: StepPhase;
    loc: StepLoc;
    // For function steps, name of the function
    functionName?: string;
    nodeType: string;
    snippet?: string;
}

export interface StepMap {
    steps: StepTarget[];
}

// Build a simple step map from the original source code.
// This does NOT transform or rewrite code; it only inspects it.
export function buildStepMap(code: string): StepMap {
    try {
        const acorn = require('acorn');
        const ast = recast.parse(code, {
            parser: {
                parse: (src: string) => acorn.parse(src, { ecmaVersion: 2020, sourceType: 'script', locations: true })
            }
        });
        const steps: StepTarget[] = [];
        const b: any[] = (ast.program && Array.isArray((ast.program as any).body)) ? (ast.program as any).body : [];
        const lines = typeof code === 'string' ? code.split(/\r?\n/) : [];

        let id = 1;

        const normalizeSnippet = (text: string) => text.replace(/\s+/g, ' ').trim();

        const extractSnippet = (loc: any): string => {
            try {
                if (!loc || !loc.start || !loc.end || !Array.isArray(lines) || lines.length === 0) return '';
                const startLine = Math.max(loc.start.line - 1, 0);
                const endLine = Math.max(loc.end.line - 1, 0);
                if (startLine === endLine) {
                    const line = lines[startLine] || '';
                    return normalizeSnippet(line.slice(loc.start.column, loc.end.column));
                }
                const parts: string[] = [];
                const first = lines[startLine] || '';
                parts.push(first.slice(loc.start.column));
                for (let lineIndex = startLine + 1; lineIndex < endLine; lineIndex++) {
                    parts.push(lines[lineIndex] || '');
                }
                const last = lines[endLine] || '';
                parts.push(last.slice(0, loc.end.column));
                return normalizeSnippet(parts.join('\n'));
            } catch {
                return '';
            }
        };

        const getExecutableLoc = (node: any) => {
            if (!node) return null;
            switch (node.type) {
                case 'ExpressionStatement':
                    if (node.expression && node.expression.loc) return node.expression.loc;
                    break;
                case 'VariableDeclaration': {
                    const withLoc = (node.declarations || []).find((d: any) => (d && d.init && d.init.loc) || (d && d.id && d.id.loc));
                    if (withLoc) {
                        if (withLoc.init && withLoc.init.loc) return withLoc.init.loc;
                        if (withLoc.id && withLoc.id.loc) return withLoc.id.loc;
                    }
                    break;
                }
                case 'ReturnStatement':
                case 'ThrowStatement':
                    if (node.argument && node.argument.loc) return node.argument.loc;
                    break;
            }
            return node.loc || null;
        };

        const pushStep = (phase: StepPhase, node: any, functionName?: string) => {
            if (!node) return;
            const loc = getExecutableLoc(node);
            if (!loc) return;
            const snippet = extractSnippet(loc);
            const start = loc.start || { line: 1, column: 0 };
            const end = loc.end || start;
            steps.push({
                id: id++,
                phase,
                loc: {
                    line: start.line,
                    column: start.column + 1,
                    endLine: end.line,
                    endColumn: end.column + 1,
                },
                functionName,
                nodeType: node.type || 'Unknown',
                snippet,
            });
        };

        // First pass: find setup and draw functions, and other top-level functions.
        const setupFns: any[] = [];
        const drawFns: any[] = [];
        const otherFns: any[] = [];
        const customFnSet = new Set<any>();

        const registerCustomFunction = (fn: any) => {
            if (!fn || fn.type !== 'FunctionDeclaration') return;
            if (!fn.id || typeof fn.id.name !== 'string') return;
            const name = fn.id.name;
            if (name === 'setup' || name === 'draw') return;
            if (customFnSet.has(fn)) return;
            customFnSet.add(fn);
            otherFns.push(fn);
        };

        for (const n of b) {
            if (!n || n.type !== 'FunctionDeclaration') continue;
            if (!n.id || typeof n.id.name !== 'string') continue;
            if (n.id.name === 'setup') setupFns.push(n);
            else if (n.id.name === 'draw') drawFns.push(n);
            else registerCustomFunction(n);
        }

        const hasSetup = setupFns.length > 0;

        // Recursively collect steps for simple statements inside blocks/control-flow.
        const isWindowCopyAssignment = (node: any) => {
            if (!node || node.type !== 'ExpressionStatement') return false;
            const expr = node.expression;
            if (!expr || expr.type !== 'AssignmentExpression' || expr.operator !== '=') return false;
            const left = expr.left;
            if (!left || left.type !== 'MemberExpression' || left.computed) return false;
            const obj = left.object;
            if (!obj || obj.type !== 'Identifier' || obj.name !== 'window') return false;
            const prop = left.property;
            if (!prop || prop.type !== 'Identifier') return false;
            const right = expr.right;
            if (!right || right.type !== 'Identifier') return false;
            return prop.name === right.name;
        };

        const collectStatements = (nodes: any[], phase: StepPhase, functionName?: string) => {
            for (const node of nodes) {
                if (!node || node.type === 'EmptyStatement') continue;

                switch (node.type) {
                    case 'IfStatement': {
                        // Step on the condition/header before entering branch bodies.
                        pushStep(phase, node, functionName);
                        if (node.consequent && Array.isArray(node.consequent.body)) {
                            collectStatements(node.consequent.body, phase, functionName);
                        } else if (node.consequent) {
                            collectStatements([node.consequent], phase, functionName);
                        }
                        if (node.alternate) {
                            if (Array.isArray(node.alternate.body)) collectStatements(node.alternate.body, phase, functionName);
                            else collectStatements([node.alternate], phase, functionName);
                        }
                        break;
                    }
                    case 'BlockStatement': {
                        collectStatements(node.body || [], phase, functionName);
                        break;
                    }
                    case 'ForStatement':
                    case 'ForInStatement':
                    case 'ForOfStatement':
                    case 'WhileStatement':
                    case 'DoWhileStatement': {
                        pushStep(phase, node, functionName);
                        if (node.body) {
                            const bodyNodes = node.body.body && Array.isArray(node.body.body) ? node.body.body : [node.body];
                            collectStatements(bodyNodes, phase, functionName);
                        }
                        break;
                    }
                    case 'SwitchStatement': {
                        pushStep(phase, node, functionName);
                        for (const cs of node.cases || []) {
                            collectStatements(cs.consequent || [], phase, functionName);
                        }
                        break;
                    }
                    case 'FunctionDeclaration': {
                        registerCustomFunction(node);
                        break;
                    }
                    default: {
                        if (isWindowCopyAssignment(node)) {
                            break;
                        }
                        // Simple statement.
                        pushStep(phase, node, functionName);
                        break;
                    }
                }
            }
        };

        // Phase 1: top-level non-function statements in order
        collectStatements(b.filter((n: any) => n && n.type !== 'FunctionDeclaration'), 'top-level');

        // Phase 2: setup body statements (if any)
        for (const fn of setupFns) {
            const body = fn.body && Array.isArray(fn.body.body) ? fn.body.body : [];
            collectStatements(body, 'setup');
        }

        // Phase 3: draw body statements (if any)
        for (const fn of drawFns) {
            const body = fn.body && Array.isArray(fn.body.body) ? fn.body.body : [];
            collectStatements(body, 'draw');
        }

        // Phase 4: custom function bodies (for later step-into support)
        for (const fn of otherFns) {
            const name = fn.id && fn.id.name ? fn.id.name : undefined;
            const body = fn.body && Array.isArray(fn.body.body) ? fn.body.body : [];
            collectStatements(body, 'function', name);
        }

        return { steps };
    } catch {
        return { steps: [] };
    }
}
