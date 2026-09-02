import * as vscode from 'vscode';

function dedupeLineTags(input: string): string {
  const text = String(input || '');
  const lineTagRe = /\(line\s+\d+(?:,\s*col\s*\d+)?\)/ig;
  const tags = text.match(lineTagRe);
  if (!tags || tags.length === 0) return text;
  const lastTag = tags[tags.length - 1];
  const base = text.replace(lineTagRe, '').trim();
  return (base + ' ' + lastTag).trim();
}

function hasRuntimePrefix(input: string): boolean {
  return /^\s*\[‼️RUNTIME ERROR(?:\s+on\s+line\s+\d+)?\]/i.test(String(input || ''));
}

function parseLineInfo(input: string): { line?: number; col?: number } {
  const text = String(input || '');
  const lineTagRe = /\(line\s+(\d+)(?:,\s*col\s*(\d+))?\)/ig;
  let m: RegExpExecArray | null = null;
  let last: RegExpExecArray | null = null;
  while ((m = lineTagRe.exec(text)) !== null) {
    last = m;
  }
  if (last) {
    const line = Number(last[1]);
    const col = last[2] ? Number(last[2]) : 1;
    if (Number.isFinite(line) && line > 0) {
      return { line, col: Number.isFinite(col) && col > 0 ? col : 1 };
    }
  }
  const headerMatch = text.match(/^\s*\[‼️RUNTIME ERROR\s+on\s+line\s+(\d+)\]/i);
  if (headerMatch) {
    const line = Number(headerMatch[1]);
    if (Number.isFinite(line) && line > 0) {
      return { line, col: 1 };
    }
  }
  return {};
}

function applyRuntimeLineHeader(input: string, line?: number): string {
  const text = String(input || '').trim();
  const m = text.match(/^\s*\[‼️RUNTIME ERROR(?:\s+on\s+line\s+\d+)?\]\s*/i);
  if (!m) return text;
  let rest = text.slice(m[0].length).trimStart();
  rest = rest.replace(/^(?:\[‼️RUNTIME ERROR(?:\s+on\s+line\s+\d+)?\]\s*)+/i, '').trimStart();
  if (Number.isFinite(line) && (line as number) > 0) {
    return (`[‼️RUNTIME ERROR on line ${line}] ${rest}`).trim();
  }
  return (`[‼️RUNTIME ERROR] ${rest}`).trim();
}

function normalizeRuntimeErrorMessage(input: string): { message: string; line?: number; col?: number } {
  const info = parseLineInfo(input);
  let text = dedupeLineTags(input);
  text = text.replace(/\s*\(line\s+\d+(?:,\s*col\s*\d+)?\)/ig, '').trim();
  if (!hasRuntimePrefix(text)) {
    text = `[‼️RUNTIME ERROR] ${text}`.trim();
  }
  text = applyRuntimeLineHeader(text, info.line);
  return { message: text, line: info.line, col: info.col };
}

export function handleShowError(
  params: { panel: vscode.WebviewPanel; editor: vscode.TextEditor; message: any },
  deps: {
    getTime: () => string;
    formatSyntaxErrorMsg: (s: string) => string;
    outputChannel: vscode.OutputChannel;
  }
) {
  // Always prefix with timestamp and [RUNTIME ERROR] if string and not already prefixed
  let message = params.message;
  let parsedLine: number | undefined;
  let parsedCol: number | undefined;
  if (typeof message === 'string') {
    const cleaned = message.replace(/\[object Arguments\]/gi, 'no argument(s) ');
    const normalized = normalizeRuntimeErrorMessage(cleaned);
    message = normalized.message;
    parsedLine = normalized.line;
    parsedCol = normalized.col;
    const time = deps.getTime();
    if (!/^\d{2}:\d{2}:\d{2}/.test(message)) {
      message = `${time} ${message}`;
    }
    if (message.includes('[‼️SYNTAX ERROR')) {
      message = deps.formatSyntaxErrorMsg(message);
    }
  }
  deps.outputChannel.appendLine(message);
  try {
    if (Number.isFinite(parsedLine) && (parsedLine as number) > 0) {
      const safeCol = Number.isFinite(parsedCol) && (parsedCol as number) > 0 ? (parsedCol as number) : 1;
      const pathHint = `${params.editor.document.uri.fsPath}:${parsedLine}:${safeCol}`;
      deps.outputChannel.appendLine(pathHint);
    }
  } catch { /* ignore */ }
  // Also fix overlay message
  const overlayMsg = typeof params.message === 'string'
    ? normalizeRuntimeErrorMessage(params.message.replace(/\[object Arguments\]/gi, 'no argument(s) ')).message
    : params.message;
  // Track last runtime error on the panel
  (params.panel as any)._lastRuntimeError = message;
  // Forward improved message to overlay if needed
  try {
    const isRuntimeOverlay = (typeof overlayMsg === 'string') && hasRuntimePrefix(overlayMsg);
    // Runtime errors are already rendered in-webview; re-posting can cause visible flash.
    if (!isRuntimeOverlay) {
      params.panel.webview.postMessage({ type: 'showError', message: overlayMsg });
    }
  } catch { /* ignore */ }
}
