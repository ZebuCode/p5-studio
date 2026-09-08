import * as vscode from 'vscode';
import type { VarControl } from '../types';

export type GlobalVar = { name: string; value: any; type: string; control?: VarControl; readonly?: boolean };

export interface VariablesViewDeps {
  getActiveP5Panel: () => vscode.WebviewPanel | undefined;
  getDocUriForPanel: (panel: vscode.WebviewPanel | undefined) => vscode.Uri | undefined;
  getGlobalsForDoc: (docUri: string) => GlobalVar[];
  getLocalsForDoc: (docUri: string) => GlobalVar[];
  getLocalsHeadingForDoc: (docUri: string) => 'locals' | 'variables';
  getHasDrawForDoc: (docUri: string) => boolean;
  setGlobalValue: (docUri: string, name: string, value: any, opts?: { updatedAt?: number }) => void;
  setLocalValue: (docUri: string, name: string, value: any) => void;
  // One-shot: return true to force the webview to rebuild its tables (dropping focus).
  consumeForceRebuildForDoc?: (docUri: string) => boolean;
}

let variablesPanelView: vscode.WebviewView | undefined;

export function registerVariablesView(context: vscode.ExtensionContext, deps: VariablesViewDeps) {
  function updateVariablesPanel() {
    if (!variablesPanelView) return;
    try {
      const panel = deps.getActiveP5Panel();
      let globals: GlobalVar[] = [];
      let locals: GlobalVar[] = [];
      let localsHeading: 'locals' | 'variables' = 'locals';
      let hasDraw = false;
      let forceRebuild = false;
      if (panel) {
        const docUri = deps.getDocUriForPanel(panel)?.toString();
        if (docUri) {
          globals = deps.getGlobalsForDoc(docUri) || [];
          locals = deps.getLocalsForDoc(docUri) || [];
          try {
            localsHeading = deps.getLocalsHeadingForDoc(docUri) || 'locals';
          } catch { }
          try {
            hasDraw = !!deps.getHasDrawForDoc(docUri);
          } catch { hasDraw = false; }
          try { forceRebuild = !!deps.consumeForceRebuildForDoc?.(docUri); } catch { forceRebuild = false; }
        }
      }
      variablesPanelView.webview.postMessage({ type: 'setVarsSplit', globals, locals, localsHeading, hasDraw, forceRebuild });
    } catch { }
  }

  const provider: vscode.WebviewViewProvider = {
    resolveWebviewView(webviewView: vscode.WebviewView) {
      variablesPanelView = webviewView;
      webviewView.webview.options = {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.file(context.extensionPath)]
      } as any;
      // Get the configured font size from the extension setting
      webviewView.webview.html = `<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8" />
    <style>
      html, body { margin: 0 !important; padding: 0 !important; }
      body { font-family: monospace; color: var(--vscode-editor-foreground); background: transparent; font-size: 12px; }
      .wrap { padding: 8px !important; overflow-x: auto; }
      .muted { opacity: 0.8; }
      h3 { margin: 8px 0 6px 0; color: #307dc1; }
      table { border-collapse: collapse; width: 100%; font-size: 12px; margin-bottom: 10px; table-layout: fixed; }
      th, td {
        border: 1px solid #8884;
        padding: 2px 4px;
        text-align: left;
        height: 20px;
        vertical-align: middle;
      }
      th.name-col, td.name-col {
        width: 25%;
        min-width: 150px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      th.value-col, td.value-col { width: 55%; }
      th.type-col, td.type-col { width: 20%; }
      td.value-col { overflow: hidden; }
      td.value-col {
        position: relative;
      }
      td.value-col.readonly-cell {
        padding-right: 22px;
      }
      .readonly-lock {
        position: absolute;
        right: 6px;
        top: calc(50% + 3px);
        transform: translateY(-50%);
        width: 10px;
        height: 8px;
        border-radius: 2px;
        background: #2f78b9;
        opacity: 0.95;
        pointer-events: none;
        display: inline-block;
      }
      .readonly-lock::before {
        content: '';
        position: absolute;
        left: 50%;
        top: -5px;
        width: 7px;
        height: 5px;
        transform: translateX(-50%);
        border: 2px solid #2f78b9;
        border-bottom: none;
        border-radius: 6px 6px 0 0;
        box-sizing: border-box;
      }
      .readonly-lock::after {
        content: '';
        position: absolute;
        left: 50%;
        top: 3px;
        width: 3px;
        height: 3px;
        transform: translateX(-50%);
        border-radius: 50%;
        background: var(--vscode-editor-background, #1e1e1e);
        opacity: 0.9;
      }
      /* Responsive: when the Value column would drop below 256px, hide the Type column */
      table.hide-type-col th.type-col,
      table.hide-type-col td.type-col {
        display: none;
      }
      /* Keep Name width stable; give extra space to Value when Type is hidden */
      /* When Type is hidden, keep Name stable and give space to Value */
      table.hide-type-col th.name-col,
      table.hide-type-col td.name-col { width: 25%; min-width: 175px; }
      table.hide-type-col th.value-col,
      table.hide-type-col td.value-col { width: 75%; }

      /* Responsive: when Value column gets too narrow, hide slider (range) controls */
      table.hide-sliders input[data-slider-field="true"] {
        display: none;
      }
      table.hide-sliders .slider-wrapper {
        gap: 0;
      }
      table.hide-sliders .slider-wrapper .slider-number-wrapper {
        width: 100% !important;
        min-width: 0 !important;
      }
      th { background: #2222; color: #307dc1; }
      /* Make inputs fill the table cell (render-only) */
      input[type="number"],
      input[type="text"],
      input[data-type="array"],
      .vscode-theme-input {
        width: 100%;
        max-width: 100%;
        box-sizing: border-box;
        display: block;
        background: var(--vscode-input-background);
        border: 1px solid var(--vscode-input-border, var(--vscode-input-background));
        color: var(--vscode-input-foreground);
        padding: 2px 4px;
        border-radius: 2px;
        font-size: 11px;
      }
      /* Align number spinners with VS Code theme */
      input[type="number"] {
        -moz-appearance: textfield;
        -webkit-appearance: none;
      }
      input[type="number"]::-webkit-inner-spin-button,
      input[type="number"]::-webkit-outer-spin-button {
        -webkit-appearance: none;
        appearance: none;
        margin: 0;
        display: none;
      }
      input[type="number"]::-moz-number-spin-box,
      input[type="number"]::-moz-number-spin-up,
      input[type="number"]::-moz-number-spin-down {
        -moz-appearance: none;
        margin: 0;
        display: none;
      }
      .number-wrapper {
        position: relative;
        width: 100%;
        display: block;
      }
      .number-wrapper input[type="number"] {
        padding-right: 18px;
      }
      .spin-buttons {
        position: absolute;
        top: 1px;
        bottom: 1px;
        right: 1px;
        width: 14px;
        display: flex;
        flex-direction: column;
        gap: 1px;
      }
      .spin-btn {
        flex: 1;
        border: 1px solid #3c3c3c;
        background: #313131;
        color: #2f78b9;
        padding: 0;
        margin: 0;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 2px;
      }
      .spin-btn:hover {
        background: #3b3b3b;
      }
      .spin-btn:focus-visible {
        outline: 1px solid var(--vscode-focusBorder);
      }
      .spin-btn::before {
        content: '';
        width: 0;
        height: 0;
        border-left: 3px solid transparent;
        border-right: 3px solid transparent;
      }
      .spin-btn.spin-up::before {
        border-bottom: 5px solid #2f78b9;
      }
      .spin-btn.spin-down::before {
        border-top: 5px solid #2f78b9;
      }
      input[type="number"]:focus,
      input[type="text"]:focus,
      input[data-type="array"]:focus {
        outline: 1px solid var(--vscode-focusBorder);
        outline-offset: 0;
      }
      .checkbox-wrapper {
        position: relative;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        height: 100%;
        min-height: 0;
        height: 14px;
        line-height: 0;
        vertical-align: middle;
      }
      .checkbox-wrapper input[type="checkbox"] {
        position: absolute;
        height: 22px;
        width: 14px;
        align-self: center;
        height: 14px;
        top: 0;
        left: 0;
        margin: 0;
        cursor: pointer;
        opacity: 0;
        -webkit-appearance: none;
        appearance: none;
        z-index: 1;
      }
      .checkbox-custom {
        width: 14px;
        height: 14px;
        border-radius: 2px;
        border: 1px solid var(--vscode-checkbox-border, var(--vscode-editorWidget-border, #3c3c3c));
        background: var(--vscode-checkbox-background, var(--vscode-editorWidget-background, #1e1e1e));
        display: inline-flex;
        align-items: center;
        justify-content: center;
        line-height: 0;
        pointer-events: none;
        z-index: 0;
      }
      .checkbox-wrapper input[type="checkbox"]:hover + .checkbox-custom {
        border-color: var(--vscode-checkbox-foreground, #2f78b9);
      }
      .checkbox-wrapper input[type="checkbox"]:focus-visible + .checkbox-custom {
        outline: 1px solid var(--vscode-focusBorder);
        outline-offset: 1px;
      }
      .checkbox-wrapper input[type="checkbox"]:checked + .checkbox-custom {
        background: var(--vscode-checkbox-foreground, #2f78b9);
        border-color: var(--vscode-checkbox-foreground, #2f78b9);
      }
      .checkbox-wrapper input[type="checkbox"]:checked + .checkbox-custom::after {
        content: '';
        width: 4px;
        height: 8px;
        border-right: 2px solid var(--vscode-editor-background, #1e1e1e);
        border-bottom: 2px solid var(--vscode-editor-background, #1e1e1e);
        transform: rotate(45deg);
        margin-bottom: 1px;
      }
      .slider-wrapper {
        display: flex;
        align-items: center;
        gap: 6px;
        height: 100%;
        min-height: 0;
        min-width: 0;
      }
      .slider-wrapper input[type="range"] {
        flex: 1;
        min-width: 0;
        width: 100%;
        accent-color: #2f78b9;
        background-color: transparent;
        -webkit-appearance: none;
        height: 22px;
        margin: 0;
        align-self: center;
        outline: none;
        border: none;
      }
      .slider-wrapper input[type="range"]:focus,
      .slider-wrapper input[type="range"]:focus-visible {
        outline: 1px solid var(--vscode-focusBorder, #2f78b9);
        outline-offset: 0;
        box-shadow: 0 0 0 0.5px var(--vscode-focusBorder, #2f78b9);
      }
      .slider-wrapper input[type="range"]::-webkit-slider-runnable-track {
        background-color: #313131;
        border-radius: 999px;
        height: 6px;
        margin: 0;
      }
      .slider-wrapper input[type="range"]::-moz-range-track {
        background-color: #313131;
        border-radius: 999px;
        height: 6px;
        margin: 0;
      }
      .slider-wrapper input[type="range"]::-ms-track {
        background-color: transparent;
        border-color: transparent;
        color: transparent;
      }
      .slider-wrapper input[type="range"]::-ms-fill-lower,
      .slider-wrapper input[type="range"]::-ms-fill-upper {
        background-color: #313131;
        border-radius: 999px;
      }
      .slider-wrapper input[type="range"]::-webkit-slider-thumb {
        -webkit-appearance: none;
        width: 14px;
        height: 14px;
        border-radius: 50%;
        background-color: #2f78b9;
        border: 1px solid #1e1e1e;
        margin-top: -4px;
        cursor: pointer;
      }
      .slider-wrapper input[type="range"]::-moz-range-thumb {
        width: 14px;
        height: 14px;
        border-radius: 50%;
        background-color: #2f78b9;
        border: 1px solid #1e1e1e;
        cursor: pointer;
      }
      .slider-wrapper input[type="range"]::-ms-thumb {
        width: 14px;
        height: 14px;
        border-radius: 50%;
        background-color: #2f78b9;
        border: 1px solid #1e1e1e;
        cursor: pointer;
      }
      .slider-wrapper input[type="range"][disabled] {
        opacity: 0.5;
      }
      .slider-value-input {
        min-width: 58px;
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .slider-wrapper .slider-number-wrapper {
        width: 64px;
        min-width: 64px;
      }
      .slider-wrapper .slider-number-wrapper input {
        text-align: right;
        padding-right: 18px;
      }
      input.error,
        input[data-invalid="true"] {
        border-color: var(--vscode-inputValidation-errorBorder, #f14c4c) !important;
        background-color: var(--vscode-inputValidation-errorBackground, rgba(241,76,76,0.18)) !important;
        box-shadow: 0 0 0 1px var(--vscode-inputValidation-errorBorder, #f14c4c);
      }
</style>
  </head>
  <body>
    <div class="wrap">
      <div id="variables-empty-state" class="muted" style="display:none;">No variables</div>
      <div id="globals-table"></div>
      <div id="locals-table"></div>
    </div>
          <script>
// Acquire VS Code API once and reuse (be defensive: avoid ReferenceError in some webview contexts)
const vscode = (typeof acquireVsCodeApi === 'function')
  ? acquireVsCodeApi()
  : (window.acquireVsCodeApi ? window.acquireVsCodeApi() : null);
const emptyStateEl = document.getElementById('variables-empty-state');
const globalsTableEl = document.getElementById('globals-table');
const localsTableEl = document.getElementById('locals-table');
const RESPONSIVE_VALUE_MIN_PX = 256;
const RESPONSIVE_SLIDER_MIN_PX = 140;
// Type column visibility: consider combined width of Name + Value columns
// (this avoids hiding Type too early when Value alone dips under the threshold).
const RESPONSIVE_NAME_VALUE_MIN_PX = 280;

function measureColWidthWhenTypeVisible(table, selector) {
  if (!table) return 0;
  var hadHiddenType = table.classList.contains('hide-type-col');
  try {
    // Measure column width *as if* the Type column is visible.
    if (hadHiddenType) table.classList.remove('hide-type-col');
    var cell = selector ? table.querySelector(selector) : null;
    if (cell && typeof cell.getBoundingClientRect === 'function') {
      return cell.getBoundingClientRect().width;
    }
    return 0;
  } catch {
    return 0;
  } finally {
    try {
      if (hadHiddenType) table.classList.add('hide-type-col');
    } catch { }
  }
}

function updateTypeColumnVisibilityIn(containerEl) {
  if (!containerEl) return;
  var tables = containerEl.querySelectorAll('table');
  tables.forEach(function(table) {
    try {
      // 1) Decide Type visibility based on "full" layout measurement
      var nameWidthWhenFull = measureColWidthWhenTypeVisible(table, 'thead th.name-col')
        || measureColWidthWhenTypeVisible(table, 'th.name-col')
        || measureColWidthWhenTypeVisible(table, 'td.name-col');
      var valueWidthWhenFull = measureColWidthWhenTypeVisible(table, 'thead th.value-col')
        || measureColWidthWhenTypeVisible(table, 'th.value-col')
        || measureColWidthWhenTypeVisible(table, 'td.value-col');

      var namePlusValue = (Number(nameWidthWhenFull) || 0) + (Number(valueWidthWhenFull) || 0);
      var shouldHideType = namePlusValue > 0
        ? (namePlusValue < RESPONSIVE_NAME_VALUE_MIN_PX)
        : (valueWidthWhenFull > 0 && valueWidthWhenFull < RESPONSIVE_VALUE_MIN_PX);
      if (shouldHideType) table.classList.add('hide-type-col');
      else table.classList.remove('hide-type-col');

      // Ensure layout reflects the updated class before measuring widths.
      try { void table.offsetWidth; } catch { }

      // 2) Decide Slider visibility based on current rendered Value width
      var valueCell = table.querySelector('thead th.value-col') || table.querySelector('th.value-col') || table.querySelector('td.value-col');
      var valueWidthNow = 0;
      try { valueWidthNow = valueCell && valueCell.getBoundingClientRect ? valueCell.getBoundingClientRect().width : 0; } catch { valueWidthNow = 0; }
      // Hide sliders only after Type is already hidden (Type goes first).
      var typeHiddenNow = table.classList.contains('hide-type-col');
      var shouldHideSliders = typeHiddenNow && valueWidthNow > 0 && valueWidthNow < RESPONSIVE_SLIDER_MIN_PX;
      if (shouldHideSliders) table.classList.add('hide-sliders');
      else table.classList.remove('hide-sliders');
    } catch { }
  });
}

function updateTypeColumnVisibilityAll() {
  updateTypeColumnVisibilityIn(globalsTableEl);
  updateTypeColumnVisibilityIn(localsTableEl);
}

// Keep responsive state updated when the view resizes.
try {
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(function() { updateTypeColumnVisibilityAll(); });
    ro.observe(document.body);
  } else {
    window.addEventListener('resize', function() { updateTypeColumnVisibilityAll(); });
  }
} catch { }

var _localsHeading = 'locals';
function getColumnLabel(scope) {
  if (_localsHeading === 'variables') return 'Variable(s)';
  return scope === 'globals' ? 'Global vars' : 'Local vars';
}
function cloneForMessage(value) {
  if (Array.isArray(value)) {
    try { return JSON.parse(JSON.stringify(value)); }
    catch {
      try { return value.map(function(item) { return cloneForMessage(item); }); }
      catch {
        try { return Array.from(value); }
        catch { return value; }
      }
    }
  }
  return value;
}
function markArrayInvalid(input) {
  try {
    input.classList.add('error');
    input.setAttribute('data-invalid', 'true');
    input.setAttribute('aria-invalid', 'true');
    if (!input.getAttribute('title')) {
      input.setAttribute('title', 'Enter a valid JSON array.');
    }
    if (typeof input.setCustomValidity === 'function') {
      input.setCustomValidity('Enter a valid JSON array.');
    }
  } catch { }
}
function clearArrayError(input) {
  try {
    input.classList.remove('error');
    input.removeAttribute('data-invalid');
    input.removeAttribute('aria-invalid');
    if (input.getAttribute('title') === 'Enter a valid JSON array.') {
      input.removeAttribute('title');
    }
    if (typeof input.setCustomValidity === 'function') {
      input.setCustomValidity('');
    }
  } catch { }
}
function sendVarUpdate(name, value, scope) {
  var payload = cloneForMessage(value);
  var generatedAt = Date.now();
  var scopeTag = scope === 'locals' ? 'locals' : 'globals';
  if (vscode) {
    vscode.postMessage({ type: 'updateGlobalVar', name: name, value: payload, generatedAt: generatedAt, scope: scopeTag });
  } else if (window.parent) {
    parent.postMessage({ type: 'updateGlobalVar', name: name, value: payload, generatedAt: generatedAt, scope: scopeTag }, '*');
  }
}
function makeInvalidKey(name, scope) {
  return (scope || 'globals') + '::' + name;
}
var _invalidVars = new Set();
var _invalidDrafts = new Map();
function setInvalidFlag(name, scope, isInvalid) {
  var key = makeInvalidKey(name, scope);
  if (isInvalid) _invalidVars.add(key);
  else {
    _invalidVars.delete(key);
    _invalidDrafts.delete(key);
  }
}
function setInvalidDraft(name, scope, value) {
  var key = makeInvalidKey(name, scope);
  if (typeof value === 'string' && value.length > 0) {
    _invalidDrafts.set(key, value);
  } else {
    _invalidDrafts.delete(key);
  }
}
function applyInvalidStates(tableDiv, scope) {
  if (!tableDiv) return;
  var prefix = (scope || 'globals') + '::';
  _invalidVars.forEach(function(key) {
    if (typeof key !== 'string') return;
    if (!key.startsWith(prefix)) return;
    var name = key.slice(prefix.length);
    if (!name) return;
    var input = tableDiv.querySelector('input[data-var="' + name + '"][data-scope="' + scope + '"]');
    if (input && input.getAttribute('data-type') === 'array') {
      var stored = _invalidDrafts.get(key);
      if (typeof stored === 'string') {
        if (input.value !== stored) input.value = stored;
      }
      markArrayInvalid(input);
    }
  });
}
function pruneInvalidForScope(scope, vars) {
  var keep = new Set();
  var prefix = (scope || 'globals') + '::';
  for (var i = 0; i < vars.length; ++i) {
    keep.add(makeInvalidKey(vars[i].name, scope));
  }
  Array.from(_invalidVars).forEach(function(key) {
    if (typeof key !== 'string') return;
    if (!key.startsWith(prefix)) return;
    if (!keep.has(key)) {
      _invalidVars.delete(key);
      _invalidDrafts.delete(key);
    }
  });
}
function toggleEmptyState(show) {
  if (!emptyStateEl) return false;
  if (show) {
    emptyStateEl.style.display = 'block';
    if (globalsTableEl) globalsTableEl.style.display = 'none';
    if (localsTableEl) localsTableEl.style.display = 'none';
    return true;
  }
  emptyStateEl.style.display = 'none';
  if (globalsTableEl) globalsTableEl.style.display = 'block';
  if (localsTableEl) localsTableEl.style.display = 'block';
  return false;
}
// Live-patch support to avoid rebuilding the table on each update
var _rendered = false;
var _globalsIndex = new Map(); // name -> { type, control, readonly }
var _localsIndex = new Map();
// Track whether current sketch has a draw() function so we can allow editing
var _hasDraw = false;
function normalizeForInput(type, v) {
  if (type === 'number') {
    var n = Number(v);
    if (Number.isNaN(n)) return '';
    return n.toString();
  }
  if (type === 'array') {
    // Render arrays without surrounding brackets for compactness
    try {
      if (!Array.isArray(v)) {
        var raw = JSON.stringify(v);
        return raw && raw.length >= 2 && raw[0] === '[' && raw[raw.length - 1] === ']'
          ? raw.slice(1, raw.length - 1)
          : raw;
      }
      var json = JSON.stringify(v);
      return json && json.length >= 2 && json[0] === '[' && json[json.length - 1] === ']'
        ? json.slice(1, json.length - 1)
        : json;
    } catch { return ''; }
  }
  if (type === 'boolean') return !!v;
  if (type === 'object') {
    try { return JSON.stringify(v); }
    catch {
      try { return String(v); } catch { return '[object]'; }
    }
  }
  return (v === undefined || v === null) ? '' : String(v);
}
function sliderFieldKey(scope, name) {
  return (scope || 'globals') + '::' + name;
}
function setSliderNumberInput(container, scope, name, value) {
  if (!container) return;
  var key = sliderFieldKey(scope, name);
  var input = container.querySelector('input[data-slider-number="true"][data-slider-key="' + key + '"]');
  if (input && input.value !== value) input.value = value;
}
// Normalize localized decimal separators before parsing user input.
function parseNumberFieldValue(raw) {
  if (typeof raw !== 'string') {
    return { isValid: false, normalized: '', value: NaN, replaced: false };
  }
  var trimmed = raw.trim();
  if (!trimmed) {
    return { isValid: false, normalized: '', value: NaN, replaced: false };
  }
  var normalized = trimmed;
  var replaced = false;
  var commaCount = (normalized.match(/,/g) || []).length;
  var hasDot = normalized.indexOf('.') !== -1;
  if (commaCount === 1 && !hasDot) {
    if (normalized.endsWith(',')) {
      return { isValid: false, normalized: normalized, value: NaN, replaced: false };
    }
    normalized = normalized.replace(',', '.');
    replaced = true;
  }
  var value = Number(normalized);
  if (Number.isNaN(value)) {
    return { isValid: false, normalized: normalized, value: NaN, replaced: replaced };
  }
  return { isValid: true, normalized: normalized, value: value, replaced: replaced };
}
function adjustNumberValue(input, direction) {
  var rawStep = input.getAttribute('step');
  var parsedStep = Number(rawStep);
  var step = !rawStep || rawStep === 'any' || Number.isNaN(parsedStep) ? 1 : parsedStep;
  var parsedCurrent = parseNumberFieldValue(String(input.value || ''));
  var current = parsedCurrent.isValid ? parsedCurrent.value : 0;
  var next = current + direction * step;
  var valueStr = next.toString();
  input.value = valueStr;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  if (typeof input.focus === 'function') {
    try { input.focus({ preventScroll: true }); } catch { }
  }
}
function startSpinHold(input, direction) {
  // Single immediate step
  adjustNumberValue(input, direction);
  // Then continuous steps while holding
  var holdInterval = null;
  var cancel = function() {
    if (holdInterval) {
      clearInterval(holdInterval);
      holdInterval = null;
    }
    window.removeEventListener('pointerup', cancel, true);
    window.removeEventListener('pointercancel', cancel, true);
    window.removeEventListener('pointerleave', cancel, true);
  };
  holdInterval = setInterval(function() {
    adjustNumberValue(input, direction);
  }, 120);
  window.addEventListener('pointerup', cancel, true);
  window.addEventListener('pointercancel', cancel, true);
  window.addEventListener('pointerleave', cancel, true);
}
function decorateNumberInputs(rootEl) {
  if (!rootEl) return;
  var numberInputs = rootEl.querySelectorAll('input[data-number-field="true"][data-var]:not([data-spin-wrapped="true"])');
  numberInputs.forEach(function(input) {
    // Skip read-only/disabled inputs so spinners only appear for editable ones
    if (input.hasAttribute('readonly') || input.hasAttribute('disabled')) return;
    input.setAttribute('data-spin-wrapped', 'true');
    var wrapper = document.createElement('div');
    wrapper.className = 'number-wrapper';
    if (input.getAttribute('data-slider-number') === 'true') {
      wrapper.classList.add('slider-number-wrapper');
    }
    var parent = input.parentNode;
    if (!parent) return;
    parent.insertBefore(wrapper, input);
    wrapper.appendChild(input);
    var buttons = document.createElement('div');
    buttons.className = 'spin-buttons';
    var upBtn = document.createElement('button');
    upBtn.type = 'button';
    upBtn.className = 'spin-btn spin-up';
    upBtn.setAttribute('aria-label', 'Increase value');
    upBtn.setAttribute('tabindex', '-1');
    var downBtn = document.createElement('button');
    downBtn.type = 'button';
    downBtn.className = 'spin-btn spin-down';
    downBtn.setAttribute('aria-label', 'Decrease value');
    downBtn.setAttribute('tabindex', '-1');
    buttons.appendChild(upBtn);
    buttons.appendChild(downBtn);
    wrapper.appendChild(buttons);
    upBtn.addEventListener('pointerdown', function(evt) {
      evt.preventDefault();
      startSpinHold(input, 1);
    });
    downBtn.addEventListener('pointerdown', function(evt) {
      evt.preventDefault();
      startSpinHold(input, -1);
    });
  });
}
function buildTable(targetId, vars, scope) {
  var tableDiv = document.getElementById(targetId);
  if (!tableDiv) return;
  if (!vars.length) {
    tableDiv.innerHTML = '';
    if (scope === 'globals') _globalsIndex = new Map(); else _localsIndex = new Map();
    return;
  }

  var colLabel = getColumnLabel(scope);
  var html = '<table><thead><tr><th class="name-col">' + colLabel + '</th><th class="value-col">Value</th><th class="type-col">Type</th></tr></thead><tbody>';
  if (scope === 'globals') _globalsIndex = new Map(); else _localsIndex = new Map();
  for (var i = 0; i < vars.length; ++i) {

    var v = vars[i];
    var sliderControl = (v && v.control && v.control.kind === 'slider') ? v.control : null;
    var controlSig = sliderControl ? JSON.stringify([sliderControl.kind, sliderControl.min, sliderControl.max, sliderControl.step]) : '';
    if (scope === 'globals') _globalsIndex.set(v.name, { type: v.type, control: controlSig, readonly: !!v.readonly }); else _localsIndex.set(v.name, { type: v.type, control: controlSig, readonly: false });
    var isGlobal = scope === 'globals';
    var showReadonlyLock = isGlobal && !!v.readonly;
    var valueCellClass = showReadonlyLock ? 'value-col readonly-cell' : 'value-col';
    html += '<tr><td class="name-col">' + v.name + '</td><td class="' + valueCellClass + '">';
    var editable = isGlobal && _hasDraw && !v.readonly;
    var readonlyAttr = editable ? '' : ' readonly';
    var disabledAttr = editable ? '' : ' disabled';
    if (v.type === 'boolean') {
      html += '<label class="checkbox-wrapper"><input type="checkbox" data-var="' + v.name + '" data-scope="' + scope + '"' + (v.value ? ' checked' : '') + disabledAttr + ' /><span class="checkbox-custom" aria-hidden="true"></span></label>';
    } else if (sliderControl && v.type === 'number') {
      var sliderMin = Number(sliderControl.min);
      if (!Number.isFinite(sliderMin)) sliderMin = 0;
      var sliderMax = Number(sliderControl.max);
      if (!Number.isFinite(sliderMax)) sliderMax = sliderMin + 1;
      if (sliderMax < sliderMin) {
        var tmp = sliderMax;
        sliderMax = sliderMin;
        sliderMin = tmp;
      }
      var sliderStep = (typeof sliderControl.step === 'number' && sliderControl.step > 0) ? sliderControl.step : Math.abs(sliderMax - sliderMin) / 100;
      if (!Number.isFinite(sliderStep) || sliderStep <= 0) sliderStep = 1;
      var sliderValueRaw = normalizeForInput('number', v.value);
      var sliderValueNum = Number(sliderValueRaw);
      if (!Number.isFinite(sliderValueNum)) sliderValueNum = sliderMin;
      if (sliderValueNum < sliderMin) sliderValueNum = sliderMin;
      if (sliderValueNum > sliderMax) sliderValueNum = sliderMax;
      var sliderValueStr = sliderValueNum.toString();
      var sliderKey = sliderFieldKey(scope, v.name);
      html += '<div class="slider-wrapper">'
        + '<input type="text" class="slider-value-input" data-slider-number="true" data-slider-key="' + sliderKey + '" data-number-field="true" lang="en" inputmode="decimal" autocomplete="off" data-var="' + v.name + '" data-scope="' + scope + '" value="' + sliderValueStr + '" step="any"' + readonlyAttr + ' />'
        + '<input type="range" data-slider-field="true" data-slider-key="' + sliderKey + '" data-var="' + v.name + '" data-scope="' + scope + '" min="' + sliderMin + '" max="' + sliderMax + '" step="' + sliderStep + '" value="' + sliderValueStr + '"' + disabledAttr + ' />'
        + '</div>';
    } else if (v.type === 'number') {
      html += '<input type="text" data-number-field="true" lang="en" inputmode="decimal" autocomplete="off" data-var="' + v.name + '" data-scope="' + scope + '" value="' + normalizeForInput('number', v.value) + '" step="any"' + readonlyAttr + ' />';
    } else if (v.type === 'array') {
      html += '<input type="text" data-var="' + v.name + '" data-scope="' + scope + '" data-type="array" value="' + normalizeForInput('array', v.value).replace(/"/g, '&quot;') + '"' + readonlyAttr + ' />';
    } else {
      html += '<input type="text" data-var="' + v.name + '" data-scope="' + scope + '" value="' + normalizeForInput('text', v.value) + '"' + readonlyAttr + ' />';
    }
    if (showReadonlyLock) {
      html += '<span class="readonly-lock" title="Read-only constant" aria-hidden="true"></span>';
    }
    html += '</td><td class="type-col">' + v.type + '</td></tr>';
  }
  html += '</tbody></table>';

  tableDiv.innerHTML = html;
  decorateNumberInputs(tableDiv);
  updateTypeColumnVisibilityIn(tableDiv);
  var varsByName = new Map();
  for (var k = 0; k < vars.length; ++k) {
    varsByName.set(vars[k].name, vars[k]);
  }
  var inputs = tableDiv.querySelectorAll('input[data-var]');
  inputs.forEach(function(input) {
    var name = input.getAttribute('data-var');
    var scopeAttr = input.getAttribute('data-scope') || 'globals';
    var isGlobal = scopeAttr === 'globals';
    var currentVar = varsByName.get(name);
    var editable = isGlobal && _hasDraw && !(currentVar && currentVar.readonly);
    if (!editable) {
      return; // keep locals and no-draw sketches read-only
    }
    if (input.type === 'checkbox') {
      input.addEventListener('change', function() { sendVarUpdate(name, input.checked, scopeAttr); });
    } else if (input.getAttribute('data-slider-field') === 'true') {
      const sliderKey = input.getAttribute('data-slider-key');
      const numberInput = sliderKey
        ? tableDiv.querySelector('input[data-slider-number="true"][data-slider-key="' + sliderKey + '"]')
        : null;
      const updateNumber = function(normalized) {
        if (!numberInput) return;
        if (numberInput.value !== normalized) numberInput.value = normalized;
      };
      const handleSlider = function() {
        var parsed = parseNumberFieldValue(String(input.value));
        if (!parsed.isValid) return;
        updateNumber(parsed.normalized);
        sendVarUpdate(name, parsed.value, scopeAttr);
      };
      input.addEventListener('input', handleSlider);
      input.addEventListener('change', handleSlider);
    } else if (input.getAttribute('data-number-field') === 'true') {
      const sliderKey = input.getAttribute('data-slider-number') === 'true'
        ? input.getAttribute('data-slider-key')
        : null;
      const sliderField = sliderKey
        ? tableDiv.querySelector('input[data-slider-field="true"][data-slider-key="' + sliderKey + '"]')
        : null;
      const syncSliderFromNumber = function(normalized, valueNum) {
        if (!sliderField) return { normalized: normalized, value: valueNum };
        var minAttr = Number(sliderField.getAttribute('min'));
        var maxAttr = Number(sliderField.getAttribute('max'));
        var clamped = valueNum;
        if (Number.isFinite(minAttr) && clamped < minAttr) clamped = minAttr;
        if (Number.isFinite(maxAttr) && clamped > maxAttr) clamped = maxAttr;
        var normalizedStr = Number.isFinite(clamped) ? clamped.toString() : normalized;
        if (sliderField.value !== normalizedStr) sliderField.value = normalizedStr;
        return { normalized: normalizedStr, value: clamped };
      };
      let numDebounceTimer = null;
      input.addEventListener('input', function() {
        if (numDebounceTimer) clearTimeout(numDebounceTimer);
        numDebounceTimer = setTimeout(function() {
          if (input.value === '') { sendVarUpdate(name, '', scopeAttr); return; }
          var parsed = parseNumberFieldValue(String(input.value));
          if (parsed.isValid) {
            let normalized = parsed.normalized;
            let valueNum = parsed.value;
            if (sliderField) {
              const synced = syncSliderFromNumber(normalized, valueNum);
              normalized = synced.normalized;
              valueNum = synced.value;
            }
            if (input.value !== normalized) input.value = normalized;
            sendVarUpdate(name, valueNum, scopeAttr);
          } else {
            sendVarUpdate(name, '', scopeAttr);
          }
        }, 25);
      });
      input.addEventListener('change', function() {
        if (input.value === '') { sendVarUpdate(name, '', scopeAttr); return; }
        var parsed = parseNumberFieldValue(String(input.value));
        if (parsed.isValid) {
          let normalized = parsed.normalized;
          let valueNum = parsed.value;
          if (sliderField) {
            const synced = syncSliderFromNumber(normalized, valueNum);
            normalized = synced.normalized;
            valueNum = synced.value;
          }
          if (input.value !== normalized) input.value = normalized;
          sendVarUpdate(name, valueNum, scopeAttr);
        } else {
          sendVarUpdate(name, '', scopeAttr);
        }
      });
    } else if (input.getAttribute('data-type') === 'array') {
      let arrDebounceTimer = null;
      input.addEventListener('input', function() {
        if (arrDebounceTimer) clearTimeout(arrDebounceTimer);
        var rawImmediate = input.value;
        if (rawImmediate.trim() === '') {
          clearArrayError(input);
          setInvalidFlag(name, scopeAttr, false);
          setInvalidDraft(name, scopeAttr, '');
        } else {
          markArrayInvalid(input);
          setInvalidFlag(name, scopeAttr, true);
          setInvalidDraft(name, scopeAttr, rawImmediate);
        }
        arrDebounceTimer = setTimeout(function() {
          var raw = input.value;
          if (raw.trim() === '') { return; }
          try {
            // User sees array contents without brackets; wrap before parsing
            var toParse = raw.trim();
            if (toParse[0] !== '[') toParse = '[' + toParse;
            if (toParse[toParse.length - 1] !== ']') toParse = toParse + ']';
            var parsed = JSON.parse(toParse);
            if (Array.isArray(parsed)) {
              clearArrayError(input);
              setInvalidFlag(name, scopeAttr, false);
              setInvalidDraft(name, scopeAttr, '');
              sendVarUpdate(name, parsed, scopeAttr);
            } else {
              markArrayInvalid(input);
              setInvalidFlag(name, scopeAttr, true);
              setInvalidDraft(name, scopeAttr, raw);
            }
          } catch {
            markArrayInvalid(input);
            setInvalidFlag(name, scopeAttr, true);
            setInvalidDraft(name, scopeAttr, raw);
          }
        }, 150);
      });
      input.addEventListener('blur', function() {
        var raw = input.value;
        if (raw.trim() === '') { return; }
        try {
          var toParse = raw.trim();
          if (toParse[0] !== '[') toParse = '[' + toParse;
          if (toParse[toParse.length - 1] !== ']') toParse = toParse + ']';
          var parsed = JSON.parse(toParse);
          if (Array.isArray(parsed)) {
            clearArrayError(input);
            setInvalidFlag(name, scopeAttr, false);
            setInvalidDraft(name, scopeAttr, '');
            sendVarUpdate(name, parsed, scopeAttr);
          } else {
            markArrayInvalid(input);
            setInvalidFlag(name, scopeAttr, true);
            setInvalidDraft(name, scopeAttr, raw);
          }
        } catch {
          markArrayInvalid(input);
          setInvalidFlag(name, scopeAttr, true);
          setInvalidDraft(name, scopeAttr, raw);
        }
      });
    } else {
      let textDebounceTimer = null;
      input.addEventListener('input', function() {
        if (textDebounceTimer) clearTimeout(textDebounceTimer);
        textDebounceTimer = setTimeout(function() {
          sendVarUpdate(name, input.value, scopeAttr);
        }, 25);
      });
      input.addEventListener('change', function() { sendVarUpdate(name, input.value, scopeAttr); });
    }
  });
  applyInvalidStates(tableDiv, scope);
  pruneInvalidForScope(scope, vars);
  _rendered = true;
}
function patchValues(targetId, vars, scope) {
  var tableDiv = document.getElementById(targetId);
  if (!tableDiv) return;
  if (!vars.length) {
    tableDiv.innerHTML = '';
    if (scope === 'globals') _globalsIndex = new Map(); else _localsIndex = new Map();
    pruneInvalidForScope(scope, []);
    return;
  }
  var needRebuild = false;
  var indexMap = scope === 'globals' ? _globalsIndex : _localsIndex;
  if (indexMap.size !== vars.length) needRebuild = true;
  for (var i = 0; i < vars.length && !needRebuild; ++i) {
    var v = vars[i];
    var sliderControl = (v && v.control && v.control.kind === 'slider') ? v.control : null;
    var controlSig = sliderControl ? JSON.stringify([sliderControl.kind, sliderControl.min, sliderControl.max, sliderControl.step]) : '';
    var meta = indexMap.get(v.name);
    if (!meta || meta.type !== v.type || (meta.control || '') !== controlSig || !!meta.readonly !== !!v.readonly) { needRebuild = true; break; }
  }
  if (needRebuild || !_rendered) { buildTable(targetId, vars, scope); return; }
  for (var j = 0; j < vars.length; ++j) {
    var vv = vars[j];
    var key = makeInvalidKey(vv.name, scope);
    if (_invalidVars.has(key)) {
      continue;
    }
    var sliderControl = (vv && vv.control && vv.control.kind === 'slider') ? vv.control : null;
    // Slider controls render two inputs (number + range). Prefer patching the range input.
    if (sliderControl && vv.type === 'number') {
      var sliderInput = tableDiv.querySelector('input[data-slider-field="true"][data-var="' + vv.name + '"][data-scope="' + scope + '"]');
      if (!sliderInput) { needRebuild = true; break; }
      var sliderKey = sliderFieldKey(scope, vv.name);
      var numberInput = tableDiv.querySelector('input[data-slider-number="true"][data-slider-key="' + sliderKey + '"]');
      if (sliderInput === document.activeElement || (numberInput && numberInput === document.activeElement)) continue;

      var sliderVal = normalizeForInput('number', vv.value);
      var sliderMinAttr = Number(sliderInput.getAttribute('min'));
      var sliderMaxAttr = Number(sliderInput.getAttribute('max'));
      var sliderNum = Number(sliderVal);
      // Avoid Number('') => 0 causing spurious resets when value is missing.
      if (sliderVal === '' || !Number.isFinite(sliderNum)) sliderNum = Number.isFinite(sliderMinAttr) ? sliderMinAttr : 0;
      if (Number.isFinite(sliderMinAttr) && sliderNum < sliderMinAttr) sliderNum = sliderMinAttr;
      if (Number.isFinite(sliderMaxAttr) && sliderNum > sliderMaxAttr) sliderNum = sliderMaxAttr;
      var sliderStr = Number.isFinite(sliderNum) ? sliderNum.toString() : sliderVal;
      if (sliderInput.value !== sliderStr) sliderInput.value = sliderStr;
      setSliderNumberInput(tableDiv, scope, vv.name, sliderStr);
      continue;
    }

    var input = tableDiv.querySelector('input[data-var="' + vv.name + '"][data-scope="' + scope + '"]');
    if (!input) { needRebuild = true; break; }
    if (input === document.activeElement) continue;
    if (input.getAttribute('data-slider-field') === 'true') {
      // Legacy/defensive: if we ever render only a range input for a var.
      var sliderVal2 = normalizeForInput('number', vv.value);
      var sliderMinAttr2 = Number(input.getAttribute('min'));
      var sliderMaxAttr2 = Number(input.getAttribute('max'));
      var sliderNum2 = Number(sliderVal2);
      if (sliderVal2 === '' || !Number.isFinite(sliderNum2)) sliderNum2 = Number.isFinite(sliderMinAttr2) ? sliderMinAttr2 : 0;
      if (Number.isFinite(sliderMinAttr2) && sliderNum2 < sliderMinAttr2) sliderNum2 = sliderMinAttr2;
      if (Number.isFinite(sliderMaxAttr2) && sliderNum2 > sliderMaxAttr2) sliderNum2 = sliderMaxAttr2;
      var sliderStr2 = Number.isFinite(sliderNum2) ? sliderNum2.toString() : sliderVal2;
      if (input.value !== sliderStr2) input.value = sliderStr2;
      setSliderNumberInput(tableDiv, scope, vv.name, sliderStr2);
    } else if (vv.type === 'boolean') {
      var chk = !!vv.value;
      if (input.checked !== chk) input.checked = chk;
    } else if (vv.type === 'number') {
      var valStr = normalizeForInput('number', vv.value);
      if (input.value !== valStr) input.value = valStr;
    } else if (vv.type === 'array') {
      var arrStr = normalizeForInput('array', vv.value);
      if (input.value !== arrStr) input.value = arrStr;
      clearArrayError(input);
      setInvalidFlag(vv.name, scope, false);
      setInvalidDraft(vv.name, scope, '');
    } else {
      var tStr = normalizeForInput('text', vv.value);
      if (input.value !== tStr) input.value = tStr;
    }
  }
  if (needRebuild) buildTable(targetId, vars, scope);
  else {
    pruneInvalidForScope(scope, vars);
    updateTypeColumnVisibilityIn(tableDiv);
  }
}
window.addEventListener('message', function(event) {
  if (event.data && event.data.type === 'setVarsSplit') {
    var globals = event.data.globals || [];
    var locals = event.data.locals || [];
    var nextHasDraw = !!event.data.hasDraw;
    if (nextHasDraw !== _hasDraw) {
      _hasDraw = nextHasDraw;
      _rendered = false;
    } else {
      _hasDraw = nextHasDraw;
    }
    if (event.data.forceRebuild) {
      // Force a rebuild so even the focused slider/field resets.
      _rendered = false;
    }
    var headingChanged = false;
    if (event.data.localsHeading === 'locals' || event.data.localsHeading === 'variables') {
      if (event.data.localsHeading !== _localsHeading) {
        _localsHeading = event.data.localsHeading;
        headingChanged = true;
      }
    }
    if (headingChanged) _rendered = false;
    if (toggleEmptyState(globals.length === 0 && locals.length === 0)) {
      _rendered = false;
      return;
    }
    toggleEmptyState(false);
    if (!_rendered) {
      buildTable('globals-table', globals, 'globals');
      buildTable('locals-table', locals, 'locals');
    } else {
      patchValues('globals-table', globals, 'globals');
      patchValues('locals-table', locals, 'locals');
    }
    updateTypeColumnVisibilityAll();
  }
});
</script>
  </body>
  </html>`;
      const triggerRefresh = () => { try { updateVariablesPanel(); } catch { } };
      triggerRefresh();
      setTimeout(triggerRefresh, 100);
      webviewView.onDidChangeVisibility(() => { if (webviewView.visible) triggerRefresh(); });
      webviewView.onDidDispose(() => { if (variablesPanelView === webviewView) variablesPanelView = undefined; });

      // Attach message listener for updates coming from Variables panel
      webviewView.webview.onDidReceiveMessage((msg) => {
        if (msg && msg.type === 'updateGlobalVar' && msg.name) {
          try {
            const name = String(msg.name);
            const value = msg.value;
            const scope = msg.scope === 'locals' ? 'locals' : 'globals';
            const panel = deps.getActiveP5Panel();
            const docUri = panel ? deps.getDocUriForPanel(panel)?.toString() : undefined;
            if (docUri) {
              if (scope === 'globals') {
                deps.setGlobalValue(docUri, name, value, { updatedAt: msg.generatedAt });
              } else {
                deps.setLocalValue(docUri, name, value);
              }
            }
            updateVariablesPanel();
          } catch { }

          const activePanel = deps.getActiveP5Panel();
          if (activePanel && activePanel.webview && msg.scope !== 'locals') {
            activePanel.webview.postMessage({ type: 'updateGlobalVar', name: msg.name, value: msg.value, generatedAt: msg.generatedAt });
          }
        }
      });
    }
  };
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('p5studioVariablesView', provider)
  );

  return { updateVariablesPanel };
}
