import * as recast from 'recast';
import { buildStepMap, StepMap, StepTarget } from './stepMap';

// Step-run: still no-op for now (we only use single-step instrumentation).
export function instrumentSetupWithDelays(code: string, _delayMs: number): string {
    return code;
}

export function instrumentRuntimeLineTracking(code: string): string {
    return code;
}

// Single-step instrumentation using the declarative step map.
// We inject minimal helpers and highlight calls in setup()/draw() only;
// the webview drives stepping with `step-advance` messages.
export function instrumentSetupForSingleStep(
    code: string,
    lineOffset: number,
    opts?: { disableTopLevelPreSteps?: boolean; docStepMap?: StepMap; topLevelGlobals?: string[] }
): string {
    try {
        const acornParser = require('recast/parsers/acorn');
        const ast = recast.parse(code, {
            parser: {
                parse: (src: string) => acornParser.parse(src, { ecmaVersion: 2020, sourceType: 'script', locations: true })
            }
        });

        const b = recast.types.builders;
        const stepMap = buildStepMap(code);
        const docStepMap = opts?.docStepMap;
        const normalizedOffset = typeof lineOffset === 'number' ? lineOffset : 0;
        const topLevelBody: any[] = (ast.program && Array.isArray((ast.program as any).body)) ? (ast.program as any).body : [];
        const hasSetupFunctionDecl = topLevelBody.some((n: any) => n && n.type === 'FunctionDeclaration' && n.id && n.id.name === 'setup');
        const allowTopLevelPreSteps = !opts?.disableTopLevelPreSteps;

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

        const revealEligible = new Set<string>((opts?.topLevelGlobals || []).map(name => String(name)));
        const restrictReveals = revealEligible.size > 0;
        const topLevelVarCounts = new Map<string, number>();
        for (const node of topLevelBody) {
            if (!node || node.type !== 'VariableDeclaration') continue;
            const loc = getExecutableLoc(node);
            if (!loc || !loc.start) continue;
            const key = `${loc.start.line}:${loc.start.column + 1}`;
            const decls = Array.isArray(node.declarations) ? node.declarations : [];
            let count = 0;
            for (const d of decls) {
                if (!d || !d.id || d.id.type !== 'Identifier') continue;
                const name = d.id.name;
                if (restrictReveals && !revealEligible.has(name)) continue;
                count++;
            }
            if (count > 0) topLevelVarCounts.set(key, count);
        }

        // Build lookup of steps per phase for quick access.
        const topSteps = stepMap.steps.filter(s => s.phase === 'top-level');
        const setupSteps = stepMap.steps.filter(s => s.phase === 'setup');
        const drawSteps = stepMap.steps.filter(s => s.phase === 'draw');
        const functionStepsByName = new Map<string, any[]>();
        for (const step of stepMap.steps) {
            if (step.phase === 'function' && step.functionName) {
                if (!functionStepsByName.has(step.functionName)) {
                    functionStepsByName.set(step.functionName, []);
                }
                functionStepsByName.get(step.functionName)!.push(step);
            }
        }
        const asyncFunctionNames = new Set(Array.from(functionStepsByName.keys()));

        const markSetupDoneExpr = () => b.expressionStatement(
            b.assignmentExpression('=',
                b.memberExpression(b.identifier('window'), b.identifier('__liveP5SetupDone')),
                b.literal(true)
            )
        );
        const setFrameWaitExpr = (value: boolean) => b.expressionStatement(
            b.assignmentExpression('=',
                b.memberExpression(b.identifier('window'), b.identifier('__liveP5ShouldWaitForFrame')),
                b.literal(value)
            )
        );
        const setFrameInProgressExpr = (value: boolean) => b.expressionStatement(
            b.assignmentExpression('=',
                b.memberExpression(b.identifier('window'), b.identifier('__liveP5FrameInProgress')),
                b.literal(value)
            )
        );
        const setFrameCounterExpr = (value: number) => b.expressionStatement(
            b.assignmentExpression('=',
                b.memberExpression(b.identifier('window'), b.identifier('__liveP5FrameCounter')),
                b.literal(value)
            )
        );
        const bumpFrameCounterExpr = () => b.expressionStatement(
            b.updateExpression('++',
                b.memberExpression(b.identifier('window'), b.identifier('__liveP5FrameCounter')),
                true
            )
        );

        // Controller helpers placed at top of program so both setup and draw can use them.
        const helpers: any[] = [];
        const createAdjustedLineExpr = (identifier: string) => {
            if (!normalizedOffset) {
                return b.identifier(identifier);
            }
            return b.conditionalExpression(
                b.identifier('n'),
                b.identifier(identifier),
                b.callExpression(
                    b.memberExpression(b.identifier('Math'), b.identifier('max')),
                    [
                        b.binaryExpression('-', b.identifier(identifier), b.literal(normalizedOffset)),
                        b.literal(1)
                    ]
                )
            );
        };

        const highlightDecl = b.expressionStatement(
            b.assignmentExpression('=',
                b.memberExpression(b.identifier('window'), b.identifier('__highlight')),
                b.arrowFunctionExpression(
                    [b.identifier('l'), b.identifier('c'), b.identifier('el'), b.identifier('ec'), b.identifier('n')],
                    b.blockStatement([
                        b.ifStatement(
                            b.memberExpression(b.identifier('window'), b.identifier('__liveP5SteppingDone')),
                            b.blockStatement([b.returnStatement(null)])
                        ),
                        b.tryStatement(
                            b.blockStatement([
                                b.expressionStatement(
                                    b.callExpression(
                                        b.memberExpression(b.identifier('vscode'), b.identifier('postMessage')),
                                        [b.objectExpression([
                                            b.property('init', b.identifier('type'), b.literal('highlightLine')),
                                            b.property('init', b.identifier('line'), createAdjustedLineExpr('l')),
                                            b.property('init', b.identifier('column'), b.identifier('c')),
                                            b.property('init', b.identifier('endLine'), createAdjustedLineExpr('el')),
                                            b.property('init', b.identifier('endColumn'), b.identifier('ec'))
                                        ])]
                                    )
                                )
                            ]),
                            b.catchClause(b.identifier('_'), null, b.blockStatement([]))
                        )
                    ])
                )
            )
        );
        const clearDecl = b.variableDeclaration('var', [
            b.variableDeclarator(
                b.identifier('__clearHighlight'),
                b.arrowFunctionExpression(
                    [b.identifier('f')],
                    b.blockStatement([
                        b.tryStatement(
                            b.blockStatement([
                                b.variableDeclaration('const', [
                                    b.variableDeclarator(
                                        b.identifier('msg'),
                                        b.objectExpression([
                                            b.property('init', b.identifier('type'), b.literal('clearHighlight'))
                                        ])
                                    )
                                ]),
                                b.ifStatement(
                                    b.binaryExpression('===',
                                        b.unaryExpression('typeof', b.identifier('f'), true),
                                        b.literal('boolean')
                                    ),
                                    b.blockStatement([
                                        b.ifStatement(
                                            b.identifier('f'),
                                            b.blockStatement([
                                                b.expressionStatement(
                                                    b.assignmentExpression('=',
                                                        b.memberExpression(b.identifier('window'), b.identifier('__liveP5SteppingDone')),
                                                        b.literal(true)
                                                    )
                                                )
                                            ])
                                        ),
                                        b.expressionStatement(
                                            b.assignmentExpression('=',
                                                b.memberExpression(b.identifier('msg'), b.identifier('final')),
                                                b.identifier('f')
                                            )
                                        )
                                    ])
                                ),
                                b.expressionStatement(
                                    b.callExpression(
                                        b.memberExpression(b.identifier('vscode'), b.identifier('postMessage')),
                                        [b.identifier('msg')]
                                    )
                                )
                            ]),
                            b.catchClause(b.identifier('_'), null, b.blockStatement([]))
                        )
                    ])
                )
            )
        ]);
        const waitDecl = b.variableDeclaration('var', [
            b.variableDeclarator(
                b.identifier('__waitStep'),
                b.arrowFunctionExpression(
                    [],
                    b.newExpression(b.identifier('Promise'), [
                        b.arrowFunctionExpression([b.identifier('rs')],
                            b.blockStatement([
                                b.expressionStatement(
                                    b.assignmentExpression('=',
                                        b.memberExpression(b.identifier('window'), b.identifier('__liveP5StepResolve')),
                                        b.identifier('rs')
                                    )
                                )
                            ])
                        )
                    ])
                )
            )
        ]);
        const advanceDecl = b.expressionStatement(
            b.assignmentExpression('=',
                b.memberExpression(b.identifier('window'), b.identifier('__liveP5StepAdvance')),
                b.functionExpression(null, [],
                    b.blockStatement([
                        b.variableDeclaration('const', [
                            b.variableDeclarator(
                                b.identifier('r'),
                                b.memberExpression(b.identifier('window'), b.identifier('__liveP5StepResolve'))
                            )
                        ]),
                        b.expressionStatement(
                            b.assignmentExpression('=',
                                b.memberExpression(b.identifier('window'), b.identifier('__liveP5StepResolve')),
                                b.literal(null)
                            )
                        ),
                        b.ifStatement(
                            b.identifier('r'),
                            b.blockStatement([b.expressionStatement(b.callExpression(b.identifier('r'), []))])
                        )
                    ])
                )
            )
        );
        const revealGlobalsDecl = b.expressionStatement(
            b.assignmentExpression('=',
                b.memberExpression(b.identifier('window'), b.identifier('__revealGlobals')),
                b.arrowFunctionExpression(
                    [b.identifier('count')],
                    b.blockStatement([
                        b.tryStatement(
                            b.blockStatement([
                                b.variableDeclaration('const', [
                                    b.variableDeclarator(
                                        b.identifier('msg'),
                                        b.objectExpression([
                                            b.property('init', b.identifier('type'), b.literal('revealGlobals'))
                                        ])
                                    )
                                ]),
                                b.ifStatement(
                                    b.binaryExpression('===',
                                        b.unaryExpression('typeof', b.identifier('count'), true),
                                        b.literal('number')
                                    ),
                                    b.blockStatement([
                                        b.expressionStatement(
                                            b.assignmentExpression('=',
                                                b.memberExpression(b.identifier('msg'), b.identifier('count')),
                                                b.identifier('count')
                                            )
                                        )
                                    ])
                                ),
                                b.expressionStatement(
                                    b.callExpression(
                                        b.memberExpression(b.identifier('vscode'), b.identifier('postMessage')),
                                        [b.identifier('msg')]
                                    )
                                )
                            ]),
                            b.catchClause(b.identifier('_'), null, b.blockStatement([]))
                        )
                    ])
                )
            )
        );
        const exposeHelpers = [
            b.expressionStatement(
                b.assignmentExpression('=',
                    b.memberExpression(b.identifier('window'), b.identifier('__liveP5Highlight')),
                    b.memberExpression(b.identifier('window'), b.identifier('__highlight'))
                )
            ),
            b.expressionStatement(
                b.assignmentExpression('=',
                    b.memberExpression(b.identifier('window'), b.identifier('__liveP5ClearHighlight')),
                    b.identifier('__clearHighlight')
                )
            ),
            b.expressionStatement(
                b.assignmentExpression('=',
                    b.memberExpression(b.identifier('window'), b.identifier('__liveP5WaitStep')),
                    b.identifier('__waitStep')
                )
            )
        ];
        const setupDoneInit = b.expressionStatement(
            b.assignmentExpression('=',
                b.memberExpression(b.identifier('window'), b.identifier('__liveP5SetupDone')),
                hasSetupFunctionDecl ? b.literal(false) : b.literal(true)
            )
        );
        const frameWaitInit = setFrameWaitExpr(true);
        const frameInProgressInit = setFrameInProgressExpr(false);
        const steppingDoneInit = b.expressionStatement(
            b.assignmentExpression('=',
                b.memberExpression(b.identifier('window'), b.identifier('__liveP5SteppingDone')),
                b.literal(false)
            )
        );
        const frameCounterInit = setFrameCounterExpr(0);
        helpers.push(highlightDecl, clearDecl, waitDecl, advanceDecl, revealGlobalsDecl, setupDoneInit, frameCounterInit, frameWaitInit, frameInProgressInit, steppingDoneInit, ...exposeHelpers);

        // Helper to create a highlight call from a StepTarget.
        const docLookup = (() => {
            if (!docStepMap || !Array.isArray(docStepMap.steps)) return null;
            const normalizeSnippet = (text: string) => (text || '').replace(/\s+/g, ' ').trim();
            const map = new Map<string, StepTarget[]>();
            for (const s of docStepMap.steps) {
                if (!s || !s.loc) continue;
                const key = `${s.nodeType}::${normalizeSnippet(s.snippet || '')}::${s.functionName || ''}`;
                if (!map.has(key)) {
                    map.set(key, []);
                }
                map.get(key)!.push(s);
            }
            return { map, normalizeSnippet, usage: new Map<string, number>() };
        })();

        const resolveDocLocForStep = (step: StepTarget) => {
            if (!docLookup) return null;
            const { map, normalizeSnippet, usage } = docLookup;
            const key = `${step.nodeType}::${normalizeSnippet(step.snippet || '')}::${step.functionName || ''}`;
            const matches = map.get(key);
            if (!matches || matches.length === 0) return null;
            const used = usage.get(key) || 0;
            const idx = Math.min(used, matches.length - 1);
            usage.set(key, used + 1);
            return matches[idx]?.loc || null;
        };

        const makeHighlightFromStep = (step: StepTarget) => {
            const docLoc = resolveDocLocForStep(step);
            const useLoc = docLoc && typeof docLoc.line === 'number' ? docLoc : step.loc;
            const alreadyNormalized = !!docLoc;
            const line = typeof useLoc?.line === 'number' ? useLoc.line : 1;
            const column = typeof useLoc?.column === 'number' ? useLoc.column : 1;
            const endLine = typeof useLoc?.endLine === 'number' ? useLoc.endLine : line;
            const endColumn = typeof useLoc?.endColumn === 'number' ? useLoc.endColumn : column;
            return b.expressionStatement(
                b.callExpression(
                    b.memberExpression(b.identifier('window'), b.identifier('__highlight')),
                    [
                        b.literal(line),
                        b.literal(column),
                        b.literal(endLine),
                        b.literal(endColumn),
                        alreadyNormalized ? b.literal(true) : b.literal(false)
                    ]
                )
            );
        };
        const makeAwaitStep = () =>
            b.ifStatement(
                b.unaryExpression('!', b.memberExpression(b.identifier('window'), b.identifier('__liveP5SteppingDone'))),
                b.blockStatement([
                    b.expressionStatement(
                        b.awaitExpression(b.callExpression(b.identifier('__waitStep'), []))
                    )
                ])
            );
        const makeRevealGlobalsCall = (count?: number) =>
            b.expressionStatement(
                b.callExpression(
                    b.memberExpression(b.identifier('window'), b.identifier('__revealGlobals')),
                    typeof count === 'number' ? [b.literal(count)] : []
                )
            );

        // Insert helpers at the very top of the program.
        (ast.program as any).body = [...helpers, ...topLevelBody];

        // Instrument setup/draw/custom bodies to emit highlight/wait in the order given by the map.
        recast.types.visit(ast, {
            visitFunctionDeclaration(path) {
                const node: any = path.value;
                if (!node || !node.id || (node.id.name !== 'setup' && node.id.name !== 'draw' && !asyncFunctionNames.has(node.id.name))) {
                    this.traverse(path);
                    return;
                }
                node.async = true;
                let phaseSteps: any[];
                if (node.id.name === 'setup') phaseSteps = setupSteps;
                else if (node.id.name === 'draw') phaseSteps = drawSteps;
                else phaseSteps = functionStepsByName.get(node.id.name) || [];

                if (node.id.name === 'draw') {
                    const setupGuard = b.ifStatement(
                        b.unaryExpression('!', b.memberExpression(b.identifier('window'), b.identifier('__liveP5SetupDone'))),
                        b.blockStatement([b.returnStatement(null)])
                    );
                    const inProgressGuard = b.ifStatement(
                        b.memberExpression(b.identifier('window'), b.identifier('__liveP5FrameInProgress')),
                        b.blockStatement([b.returnStatement(null)])
                    );
                    const frameWaitGuard = b.ifStatement(
                        b.unaryExpression('!', b.memberExpression(b.identifier('window'), b.identifier('__liveP5ShouldWaitForFrame'))),
                        b.blockStatement([
                            setFrameWaitExpr(true)
                        ]),
                        b.blockStatement([
                            b.expressionStatement(b.awaitExpression(b.callExpression(b.identifier('__waitStep'), []))),
                            setFrameWaitExpr(true)
                        ])
                    );
                    const startFrame = setFrameInProgressExpr(true);
                    const bumpFrameCounter = bumpFrameCounterExpr();
                    const existingBody = node.body && Array.isArray(node.body.body) ? node.body.body : [];
                    node.body.body = [setupGuard, inProgressGuard, frameWaitGuard, startFrame, bumpFrameCounter, ...existingBody];
                }

                // For setup: emit top-level steps first, then setup body.
                if (node.id.name === 'setup' && allowTopLevelPreSteps) {
                    const revealCall = makeRevealGlobalsCall();
                    if (topSteps.length > 0) {
                        const injected: any[] = [];
                        for (const step of topSteps) {
                            injected.push(makeHighlightFromStep(step));
                            injected.push(makeAwaitStep());
                            const revealKey = `${step.loc.line}:${step.loc.column}`;
                            const releaseCount = topLevelVarCounts.get(revealKey);
                            if (typeof releaseCount === 'number' && releaseCount > 0) {
                                injected.push(makeRevealGlobalsCall(releaseCount));
                            }
                        }
                        injected.push(revealCall);
                        node.body.body = [...injected, ...node.body.body];
                    } else {
                        node.body.body = [revealCall, ...node.body.body];
                    }
                }

                // Recursively walk the function body and inject highlight/await before each mapped step.
                const allPhaseSteps = phaseSteps.slice().sort((a, b) => a.loc.line - b.loc.line || a.loc.column - b.loc.column);
                const lastStep = allPhaseSteps[allPhaseSteps.length - 1];

                // For custom functions, ensure we clear highlight and mark stepping done only after the last function step, not after the call site.
                let _insertedFinalClear = false;
                const isCustomFunction = node.id.name && asyncFunctionNames.has(node.id.name);
                const injectIntoStatements = (stmts: any[], inLoop: boolean = false): any[] => {
                    const result: any[] = [];
                    for (const stmt of stmts) {
                        if (!stmt) continue;
                        const postActions: any[] = [];

                        if (asyncFunctionNames.size > 0) {
                            if (stmt.type === 'ExpressionStatement' && stmt.expression) {
                                if (stmt.expression.type === 'CallExpression') {
                                    const cal = stmt.expression.callee;
                                    if (cal && cal.type === 'Identifier' && asyncFunctionNames.has(cal.name)) {
                                        const originalCall = stmt.expression;
                                        const awaited = b.awaitExpression(originalCall);
                                        awaited.loc = originalCall.loc;
                                        stmt.expression = awaited;
                                    }
                                }
                            } else if (stmt.type === 'ReturnStatement' && stmt.argument) {
                                if (stmt.argument.type === 'CallExpression') {
                                    const cal = stmt.argument.callee;
                                    if (cal && cal.type === 'Identifier' && asyncFunctionNames.has(cal.name)) {
                                        const originalReturnCall = stmt.argument;
                                        const awaitedReturn = b.awaitExpression(originalReturnCall);
                                        awaitedReturn.loc = originalReturnCall.loc;
                                        stmt.argument = awaitedReturn;
                                    }
                                }
                            }
                        }
                        const execLoc = getExecutableLoc(stmt);
                        const loc = execLoc && execLoc.start ? execLoc.start : null;
                        const match = loc ? phaseSteps.find(s => s.loc.line === loc.line && s.loc.column - 1 === loc.column) : undefined;
                        if (match) {
                            result.push(makeHighlightFromStep(match));
                            const isLastPhaseStep = !!(lastStep && match.loc.line === lastStep.loc.line && match.loc.column === lastStep.loc.column);
                            const isLoopStmt = (
                                stmt.type === 'ForStatement' || stmt.type === 'ForInStatement' || stmt.type === 'ForOfStatement'
                                || stmt.type === 'WhileStatement' || stmt.type === 'DoWhileStatement'
                            );
                            const isEffectiveLast = isLastPhaseStep && !(inLoop || isLoopStmt);
                            if (isEffectiveLast) {
                                // Last step: wait once more, then clear highlight automatically.
                                result.push(makeAwaitStep());
                                if (node.id.name === 'setup') {
                                    postActions.push(markSetupDoneExpr());
                                    postActions.push(setFrameWaitExpr(false));
                                }
                                if (isCustomFunction) {
                                    // Only clear highlight for custom function after its last step, but do NOT mark stepping done.
                                    result.push(
                                        b.expressionStatement(
                                            b.callExpression(
                                                b.identifier('__clearHighlight'),
                                                [b.literal(false)]
                                            )
                                        )
                                    );
                                    _insertedFinalClear = true;
                                } else if (node.id.name === 'draw') {
                                    postActions.push(setFrameWaitExpr(false));
                                    postActions.push(setFrameInProgressExpr(false));
                                } else if (node.id.name === 'setup') {
                                    result.push(
                                        b.expressionStatement(
                                            b.callExpression(
                                                b.identifier('__clearHighlight'),
                                                [drawSteps.length === 0 ? b.literal(true) : b.literal(false)]
                                            )
                                        )
                                    );
                                    _insertedFinalClear = true;
                                } else {
                                    result.push(
                                        b.expressionStatement(
                                            b.callExpression(
                                                b.identifier('__clearHighlight'),
                                                [b.literal(false)]
                                            )
                                        )
                                    );
                                    _insertedFinalClear = true;
                                }
                            } else {
                                result.push(makeAwaitStep());
                            }
                        }

                        // Recurse into nested blocks/control-flow.
                        switch (stmt.type) {
                            case 'ExpressionStatement': {
                                // Capture simple assignments and ++/-- updates to identifiers
                                try {
                                    const expr: any = (stmt as any).expression;
                                    if (expr) {
                                        let identName: string | null = null;
                                        if (expr.type === 'AssignmentExpression') {
                                            if (expr.left && expr.left.type === 'Identifier') identName = expr.left.name;
                                        } else if (expr.type === 'UpdateExpression') {
                                            if (expr.argument && expr.argument.type === 'Identifier') identName = expr.argument.name;
                                        }
                                        if (identName) {
                                            const valueExpr = b.identifier(identName);
                                            const postMsg = b.tryStatement(
                                                b.blockStatement([
                                                    b.expressionStatement(
                                                        b.callExpression(
                                                            b.memberExpression(b.identifier('vscode'), b.identifier('postMessage')),
                                                            [b.objectExpression([
                                                                b.property('init', b.identifier('type'), b.literal('updateGlobalVar')),
                                                                b.property('init', b.identifier('name'), b.literal(identName)),
                                                                b.property('init', b.identifier('value'), valueExpr)
                                                            ])]
                                                        )
                                                    )
                                                ]),
                                                b.catchClause(b.identifier('_'), null, b.blockStatement([
                                                    b.tryStatement(
                                                        b.blockStatement([
                                                            b.expressionStatement(
                                                                b.callExpression(
                                                                    b.memberExpression(b.identifier('vscode'), b.identifier('postMessage')),
                                                                    [b.objectExpression([
                                                                        b.property('init', b.identifier('type'), b.literal('updateGlobalVar')),
                                                                        b.property('init', b.identifier('name'), b.literal(identName)),
                                                                        b.property('init', b.identifier('value'), b.memberExpression(b.identifier('window'), b.identifier(identName)))
                                                                    ])]
                                                                )
                                                            )
                                                        ]),
                                                        b.catchClause(b.identifier('__'), null, b.blockStatement([]))
                                                    )
                                                ]))
                                            );
                                            postActions.push(postMsg as any);
                                        }
                                    }
                                } catch { }
                                result.push(stmt);
                                break;
                            }
                            case 'IfStatement': {
                                if (stmt.consequent) {
                                    const bodyNodes = (stmt.consequent.body && Array.isArray(stmt.consequent.body)) ? stmt.consequent.body : [stmt.consequent];
                                    stmt.consequent.body = injectIntoStatements(bodyNodes, inLoop);
                                }
                                if (stmt.alternate) {
                                    if (stmt.alternate.body && Array.isArray(stmt.alternate.body)) {
                                        stmt.alternate.body = injectIntoStatements(stmt.alternate.body, inLoop);
                                    } else {
                                        const altInjected = injectIntoStatements([stmt.alternate], inLoop);
                                        stmt.alternate = altInjected[0] || stmt.alternate;
                                    }
                                }
                                result.push(stmt);
                                break;
                            }
                            case 'VariableDeclaration': {
                                // After executing a declaration, push live updates for declared identifiers
                                try {
                                    const decls = (stmt as any).declarations || [];
                                    for (const d of decls) {
                                        if (d && d.id && d.id.type === 'Identifier') {
                                            const name = d.id.name;
                                            // Prefer the identifier value itself (captures initialized local or global value immediately after declaration).
                                            // Fallback to window[name] only if identifier not accessible (wrapped in try/catch in runtime).
                                            const valueExpr = b.identifier(name);
                                            const postMsg = b.tryStatement(
                                                b.blockStatement([
                                                    b.expressionStatement(
                                                        b.callExpression(
                                                            b.memberExpression(b.identifier('vscode'), b.identifier('postMessage')),
                                                            [b.objectExpression([
                                                                b.property('init', b.identifier('type'), b.literal('updateGlobalVar')),
                                                                b.property('init', b.identifier('name'), b.literal(name)),
                                                                b.property('init', b.identifier('value'), valueExpr)
                                                            ])]
                                                        )
                                                    )
                                                ]),
                                                b.catchClause(b.identifier('_'), null, b.blockStatement([
                                                    b.tryStatement(
                                                        b.blockStatement([
                                                            b.expressionStatement(
                                                                b.callExpression(
                                                                    b.memberExpression(b.identifier('vscode'), b.identifier('postMessage')),
                                                                    [b.objectExpression([
                                                                        b.property('init', b.identifier('type'), b.literal('updateGlobalVar')),
                                                                        b.property('init', b.identifier('name'), b.literal(name)),
                                                                        b.property('init', b.identifier('value'), b.memberExpression(b.identifier('window'), b.identifier(name)))
                                                                    ])]
                                                                )
                                                            )
                                                        ]),
                                                        b.catchClause(b.identifier('__'), null, b.blockStatement([]))
                                                    )
                                                ]))
                                            );
                                            postActions.push(postMsg as any);
                                        }
                                    }
                                } catch { }
                                result.push(stmt);
                                if (postActions.length) {
                                    result.push(...postActions);
                                }
                                break;
                            }
                            case 'BlockStatement': {
                                stmt.body = injectIntoStatements(stmt.body || [], inLoop);
                                result.push(stmt);
                                break;
                            }
                            case 'ForStatement':
                            case 'ForInStatement':
                            case 'ForOfStatement':
                            case 'WhileStatement':
                            case 'DoWhileStatement': {
                                if (stmt.body) {
                                    const bodyNodes = (stmt.body.body && Array.isArray(stmt.body.body)) ? stmt.body.body : [stmt.body];
                                    const injectedBody = injectIntoStatements(bodyNodes, true);
                                    if (Array.isArray(stmt.body.body)) stmt.body.body = injectedBody;
                                    else stmt.body = injectedBody[0] || stmt.body;
                                }
                                result.push(stmt);
                                break;
                            }
                            case 'SwitchStatement': {
                                for (const cs of stmt.cases || []) {
                                    cs.consequent = injectIntoStatements(cs.consequent || [], inLoop);
                                }
                                result.push(stmt);
                                break;
                            }
                            default:
                                result.push(stmt);
                        }

                        if (postActions.length > 0) {
                            result.push(...postActions);
                        }
                    }
                    return result;
                };

                node.body.body = injectIntoStatements(node.body.body || [], false);
                if (node.id.name === 'setup') {
                    node.body.body.push(markSetupDoneExpr());
                    node.body.body.push(setFrameWaitExpr(false));
                    // If we didn't emit a final clear inside the last step (e.g., last step was inside a loop),
                    // clear once at the end of setup. Mark final=true only when there is no draw().
                    if (!_insertedFinalClear) {
                        node.body.body.push(
                            b.expressionStatement(
                                b.callExpression(
                                    b.identifier('__clearHighlight'),
                                    [drawSteps.length === 0 ? b.literal(true) : b.literal(false)]
                                )
                            )
                        );
                    }
                } else if (node.id.name === 'draw') {
                    node.body.body.push(setFrameWaitExpr(false));
                    node.body.body.push(setFrameInProgressExpr(false));
                }
                this.traverse(path);
                return false;
            }
        });

        return recast.print(ast).code;
    } catch {
        return code;
    }
}

