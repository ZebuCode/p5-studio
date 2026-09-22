import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { preprocessTopLevelInputs } from '../processing/topInputs';
import { extractGlobalVariablesWithConflicts, rewriteUserCodeWithWindowGlobals } from '../processing/codeRewriter';
import { injectLoopGuards, LOOP_GUARD_HELPER_SNIPPET } from '../processing/loopGuards';
import { listFilesRecursively } from '../utils/helpers';
import { config as cfg } from '../config/index';
import { getP5AssetUris } from '../assets/resolver';

export async function createHtml(
  userCode: string,
  panel: vscode.WebviewPanel,
  extensionPath: string,
  opts?: { allowInteractiveTopInputs?: boolean; initialCaptureVisible?: boolean; p5Version?: string }
): Promise<string> {
  const allowInteractive = typeof opts?.allowInteractiveTopInputs === 'boolean' ? opts!.allowInteractiveTopInputs! : true;
  const initialCaptureVisible = !!(opts && opts.initialCaptureVisible);
  // Preprocess top-of-file inputPrompt() placeholders before anything else
  const key = (panel && (panel as any)._sketchFilePath) ? String((panel as any)._sketchFilePath) : '';
  userCode = await preprocessTopLevelInputs(userCode, { key, interactive: allowInteractive });
  // Get the sketch filename (without extension)
  let sketchFileName = '';
  if (panel && (panel as any)._sketchFilePath) {
    sketchFileName = path.basename((panel as any)._sketchFilePath);
  }
  // Resolve p5 asset URIs via centralized resolver helper, honoring an explicit version when provided
  const { p5Uri, p5SoundUri, p5CaptureUri } = getP5AssetUris(panel, extensionPath, opts?.p5Version ? { version: opts.p5Version } : undefined);

  const stepRunDelayMs = cfg.getStepRunDelayMs();
  const showDebugButton = cfg.getShowDebugButton();
  const showFPS = cfg.getShowFPS();

  function escapeBackticks(str: string) {
    return str.replace(/`/g, '\\`');
  }

  // Sanitize user code: replace literal two-character "\\" + "n" sequences
  // in string literals with a space, but do NOT touch actual backslash
  // characters like "\\" that are already correctly escaped.
  function sanitizeUserCode(code: string): string {
    // This regex replaces \n in single/double/backtick-quoted string literals with a space
    return code.replace(/(['"`])((?:\\\1|.)*?)\\n((?:\\\1|.)*?)\1/g, (match, quote, before, after) => {
      return quote + before.replace(/\\n/g, ' ') + after + quote;
    });
  }
  const sanitizedCode = sanitizeUserCode(userCode);
  const loopGuardEnabled = cfg.getLoopGuardEnabled();
  // Detect globals and rewrite code
  const { globals, conflicts } = extractGlobalVariablesWithConflicts(sanitizedCode);
  const rewrittenCode = rewriteUserCodeWithWindowGlobals(sanitizedCode, globals);
  const loopGuardResult = loopGuardEnabled
    ? injectLoopGuards(rewrittenCode, { tagPrefix: sketchFileName || 'sketch' })
    : { code: rewrittenCode, modified: false };
  const escapedCode = escapeBackticks(loopGuardResult.code);
  const loopGuardHelperScript = LOOP_GUARD_HELPER_SNIPPET.trim();

  const uniqueId = Date.now() + '-' + Math.random().toString(36).substr(2, 8);
  const p5UriWithCacheBust = vscode.Uri.parse(p5Uri.toString() + `?v=${uniqueId}`);
  const p5SoundUriWithCacheBust = vscode.Uri.parse(p5SoundUri.toString() + `?v=${uniqueId}`);
  const p5CaptureUriWithCacheBust = vscode.Uri.parse(p5CaptureUri.toString() + `?v=${uniqueId}`);
  // --- Inject common, import, and include scripts ---
  let scriptTags = '';
  let styleTags = '';
  try {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    // --- Determine sketch file's folder for "include" ---
    let includeFiles: string[] = [];
    let includeCssUris: vscode.Uri[] = [];
    const includeDirs: string[] = [];
    const filterExecutableScripts = (files: string[]) => files.filter(f => f.toLowerCase().endsWith('.js') && !f.toLowerCase().endsWith('.d.ts'));
    const seenIncludeDirs = new Set<string>();
    const trackIncludeDir = (dir?: string) => {
      if (!dir) return;
      const normalized = path.normalize(dir);
      if (seenIncludeDirs.has(normalized)) return;
      seenIncludeDirs.add(normalized);
      includeDirs.push(normalized);
    };
    if (panel && (panel as any)._sketchFilePath) {
      const sketchDir = path.dirname((panel as any)._sketchFilePath);
      trackIncludeDir(path.join(sketchDir, 'include'));
      const parentDir = path.dirname(sketchDir);
      if (parentDir && parentDir !== sketchDir) {
        trackIncludeDir(path.join(parentDir, 'include'));
      }
    }
    if (workspaceFolder) {
      trackIncludeDir(path.join(workspaceFolder.uri.fsPath, 'include'));
    }
    for (const includeDir of includeDirs) {
      try {
        if (fs.existsSync(includeDir) && fs.statSync(includeDir).isDirectory()) {
          const scripts = await listFilesRecursively(vscode.Uri.file(includeDir), ['.js']);
          includeFiles = includeFiles.concat(filterExecutableScripts(scripts));
          const cssFiles = await listFilesRecursively(vscode.Uri.file(includeDir), ['.css']);
          includeCssUris.push(...cssFiles.map(f => panel.webview.asWebviewUri(vscode.Uri.file(f))));
        }
      } catch { /* ignore include errors */ }
    }
    if (workspaceFolder) {
      // --- Collect import, common, and include scripts in the requested order ---
      const importDir = path.join(workspaceFolder.uri.fsPath, 'import');
      const commonDir = path.join(workspaceFolder.uri.fsPath, 'common');
      const importFiles = filterExecutableScripts(await listFilesRecursively(vscode.Uri.file(importDir), ['.js']));
      const commonFiles = filterExecutableScripts(await listFilesRecursively(vscode.Uri.file(commonDir), ['.js']));
      // includeFiles already set above

      const allFiles = [...importFiles, ...commonFiles, ...includeFiles];

      scriptTags = `<script src='${p5UriWithCacheBust}'></script>\n` +
        `<script src='${p5SoundUriWithCacheBust}'></script>\n` +
        `<script src='${p5CaptureUriWithCacheBust}'></script>\n` +
        allFiles.map(s => `<script src='${panel.webview.asWebviewUri(vscode.Uri.file(s))}'></script>`).join('\n');

      let commonCssFiles: string[] = [];
      try {
        const commonDir = path.join(workspaceFolder.uri.fsPath, 'common');
        commonCssFiles = await listFilesRecursively(vscode.Uri.file(commonDir), ['.css']);
      } catch { commonCssFiles = []; }
      const commonCssUris = commonCssFiles.map(f => panel.webview.asWebviewUri(vscode.Uri.file(f)));
      const allCssUris = [...commonCssUris, ...includeCssUris];
      if (allCssUris.length > 0) {
        styleTags = allCssUris.map(uri => `<link rel='stylesheet' href='${uri}'>`).join('\n');
      }
    } else {
      // Fallback: just p5 and p5.sound
      scriptTags = `<script src='${p5UriWithCacheBust}'></script>\n` +
        `<script src='${p5SoundUriWithCacheBust}'></script>`;
      // capture is optional in fallback
      if (includeCssUris.length > 0) {
        styleTags = includeCssUris.map(uri => `<link rel='stylesheet' href='${uri}'>`).join('\n');
      }
    }
  } catch (e) { /* ignore */ }

  // In createHtml, get debounceDelay from config and pass to webview
  const debounceDelay = cfg.getDebounceDelay();
  const varControlDebounceDelay = cfg.getVariablePanelDebounceDelay();

  // Get the webview URI for the media folder (if it exists)
  let mediaWebviewUriPrefix = '';
  try {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder) {
      const mediaFolder = path.join(workspaceFolder.uri.fsPath, 'media');
      const mediaUri = vscode.Uri.file(mediaFolder);
      mediaWebviewUriPrefix = panel.webview.asWebviewUri(mediaUri).toString();
    }
  } catch (e) { /* ignore */ }

  // --- NEW: Get the webview URI for the include folder (if it exists) ---
  let includeWebviewUriPrefix = '';
  try {
    if (panel && (panel as any)._sketchFilePath) {
      const sketchDir = path.dirname((panel as any)._sketchFilePath);
      const includeDir = path.join(sketchDir, 'include');
      if (fs.existsSync(includeDir) && fs.statSync(includeDir).isDirectory()) {
        const includeUri = vscode.Uri.file(includeDir);
        includeWebviewUriPrefix = panel.webview.asWebviewUri(includeUri).toString();
      }
    }
  } catch (e) { /* ignore */ }

  // Match overlay font size to the editor font size
  const editorFontSize = vscode.workspace.getConfiguration('editor').get<number>('fontSize', 14);
  const loopGuardConfig = {
    enabled: loopGuardEnabled,
    maxIterations: cfg.getLoopGuardMaxIterations(),
    maxTimeMs: cfg.getLoopGuardMaxTimeMs(),
  };

  return `<!DOCTYPE html>
<!-- cache-bust: ${uniqueId} -->
<html>
<head>
${styleTags}
${scriptTags}
<script>
// Provide the sketch filename (without extension) to the webview
window._p5SketchFileName = ${JSON.stringify(sketchFileName)};
window._p5UserCode = \`${escapedCode}\`;
// --- output() alias for console.log ---
window.output = function(...args) { console.log(...args); };
// --- Provide MEDIA_FOLDER and INCLUDE_FOLDER globals for user sketches ---
// Always ensure trailing slash so MEDIA_FOLDER + "file.png" works.
(function() {
  function ensureTrailingSlash(str) {
    if (!str) return "";
    return str.endsWith("/") ? str : str + "/";
  }
  window.MEDIA_FOLDER = ensureTrailingSlash(${JSON.stringify(mediaWebviewUriPrefix)});
  window.INCLUDE_FOLDER = ensureTrailingSlash(${JSON.stringify(includeWebviewUriPrefix)});
})();
window.__p5LoopGuardActive = false;
window.__p5LoopGuardMsg = '';
window.__p5LoopGuardConfig = ${JSON.stringify(loopGuardConfig)};
</script>
<script>
// --- OSC SEND/RECEIVE API for user sketches ---
window.sendOSC = function(address, args) {
  if (typeof vscode !== "undefined" && address) {
    vscode.postMessage({ type: "oscSend", address, args: Array.isArray(args) ? args : [] });
  }
};
// --- OSC START/STOP API for user sketches ---
window.startOSC = function(localAddress, localPort, remoteAddress, remotePort) {
  if (typeof vscode !== "undefined") {
    vscode.postMessage({
      type: "startOSC",
      localAddress: localAddress,
      localPort: localPort,
      remoteAddress: remoteAddress,
      remotePort: remotePort
    });
  }
};
window.stopOSC = function() {
  if (typeof vscode !== "undefined") {
    vscode.postMessage({ type: "stopOSC" });
  }
};
// Helper: normalize OSC args (supports osc.js metadata objects)
// Example inputs: 42, [1,2], [{type:'i', value: 3}] -> returns plain JS values array
window.oscArgsToArray = function(args) {
  const list = Array.isArray(args) ? args : [args];
  return list.map(arg => (arg && typeof arg === 'object' && 'value' in arg) ? arg.value : arg);
};
// Only window.receivedOSC(address, args) is supported for incoming OSC messages.
window.addEventListener("message", function(e) {
  if (e.data && e.data.type === "oscReceive") {
    if (typeof window.receivedOSC === "function") {
      window.receivedOSC(e.data.address, e.data.args);
    }
  }
});

// --- p5Stream WebSocket API for user sketches ---
(function(){
  const LOSSY_ALLOWED_MIME_TYPES = ['image/webp', 'image/png', 'image/jpeg'];
  const DEFAULT_LOSSY_OPTIONS = { quality: 0.7, mimeType: 'image/webp' };
  function clampPositive(value, fallback){
    const n = Number(value);
    return (Number.isFinite(n) && n > 0) ? n : fallback;
  }
  const DEFAULT_STREAM_STATE = {
    ws: null,
    wsAddress: undefined,
    targetUuid: undefined,
    targetWebviewuuid: undefined,
    senderId: 'p5studio-' + Math.random().toString(36).slice(-8),
    targetFPS: 30,
    lastFrameSentAt: 0,
    lastKeyframeSentAt: 0,
    lastPixels: null,
    reconnectTimer: null,
    reconnectDelayMs: 1000,
    tileSize: 8,
    maxTileRatio: 0.6,
    maxTileCount: 200,
    maxTileSendPerFrame: 6,
    pixelPoolMaxBucket: 24,
    keyframeIntervalMs: 2000,
    lossyEnabled: false,
    lossyOptions: Object.assign({}, DEFAULT_LOSSY_OPTIONS)
  };
  window.p5Stream = Object.assign({}, DEFAULT_STREAM_STATE, window.p5Stream || {});
  window.p5Stream.lossyOptions = normalizeLossyOptions(window.p5Stream.lossyOptions);

  function clampLossyQuality(value){
    if (!Number.isFinite(value)) {
      return null;
    }
    const clamped = Math.min(1, Math.max(0.05, value));
    return clamped;
  }

  function sanitizeLossyMimeType(value){
    if (typeof value !== 'string') {
      return null;
    }
    let normalized = value.trim().toLowerCase();
    if (!normalized) {
      return null;
    }
    if (!normalized.includes('/')) {
      if (normalized === 'jpg') {
        normalized = 'jpeg';
      }
      normalized = 'image/' + normalized;
    }
    if (normalized === 'image/jpg') {
      normalized = 'image/jpeg';
    }
    return LOSSY_ALLOWED_MIME_TYPES.includes(normalized) ? normalized : null;
  }

  function normalizeLossyOptions(options){
    const merged = Object.assign({}, DEFAULT_LOSSY_OPTIONS, options || {});
    const quality = clampLossyQuality(merged.quality);
    merged.quality = quality === null ? DEFAULT_LOSSY_OPTIONS.quality : quality;
    const mime = sanitizeLossyMimeType(merged.mimeType);
    merged.mimeType = mime || DEFAULT_LOSSY_OPTIONS.mimeType;
    return merged;
  }

  function updateLossyOptions(partial){
    const ps = window.p5Stream;
    const candidate = Object.assign({}, ps.lossyOptions || {}, partial || {});
    const normalized = normalizeLossyOptions(candidate);
    ps.lossyOptions = normalized;
    return normalized;
  }

  function parseLossyArgs(arg1, arg2){
    if (arg1 && typeof arg1 === 'object') {
      return { quality: arg1.quality, mimeType: arg1.mimeType };
    }
    const result = {};
    if (typeof arg1 === 'number') {
      result.quality = arg1;
    } else if (typeof arg1 === 'string') {
      result.mimeType = arg1;
    }
    if (typeof arg2 === 'string') {
      result.mimeType = arg2;
    }
    return result;
  }

  class Uint8ClampedArrayPool {
    constructor(maxPerBucket){
      this.maxPerBucket = clampPositive(maxPerBucket, DEFAULT_STREAM_STATE.pixelPoolMaxBucket);
      this.buckets = new Map();
    }
    acquire(length){
      if (!Number.isFinite(length) || length <= 0) {
        return new Uint8ClampedArray(0);
      }
      const bucket = this.buckets.get(length);
      if (bucket && bucket.length) {
        return bucket.pop();
      }
      return new Uint8ClampedArray(length);
    }
    release(buffer){
      if (!(buffer instanceof Uint8ClampedArray) || !buffer.length) {
        return;
      }
      const length = buffer.length;
      const bucket = this.buckets.get(length) || [];
      if (bucket.length >= this.maxPerBucket) {
        return;
      }
      bucket.push(buffer);
      this.buckets.set(length, bucket);
    }
  }

  const pixelPool = new Uint8ClampedArrayPool(window.p5Stream.pixelPoolMaxBucket);

  const textEncoder = (typeof TextEncoder !== 'undefined') ? new TextEncoder() : null;

  function setLossyEnabled(ps, enabled){
    const next = !!enabled;
    if (ps.lossyEnabled === next) {
      return;
    }
    ps.lossyEnabled = next;
    if (next && ps.lastPixels) {
      pixelPool.release(ps.lastPixels);
      ps.lastPixels = null;
    }
    if (!next) {
      ps.lastKeyframeSentAt = 0;
    }
  }

  function getLossyOptions(){
    const normalized = normalizeLossyOptions(window.p5Stream.lossyOptions);
    window.p5Stream.lossyOptions = normalized;
    return normalized;
  }

  function resolveCanvasElement(){
    if (window._p5Instance && window._p5Instance._renderer && window._p5Instance._renderer.elt) {
      return window._p5Instance._renderer.elt;
    }
    if (window._renderer && window._renderer.elt) {
      return window._renderer.elt;
    }
    if (window.canvas instanceof window.HTMLCanvasElement) {
      return window.canvas;
    }
    const canvases = typeof document !== 'undefined' ? document.getElementsByTagName('canvas') : null;
    return canvases && canvases.length ? canvases[0] : null;
  }

  function dataUrlToUint8Array(dataUrl){
    if (typeof dataUrl !== 'string') {
      return new Uint8Array(0);
    }
    const commaIndex = dataUrl.indexOf(',');
    if (commaIndex === -1) {
      return new Uint8Array(0);
    }
    const base64 = dataUrl.slice(commaIndex + 1);
    const binaryString = (typeof window.atob === 'function')
      ? window.atob(base64)
      : (typeof atob === 'function' ? atob(base64) : null);
    if (!binaryString) {
      return new Uint8Array(0);
    }
    const length = binaryString.length;
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
  }

  function isSocketOpen(ps = window.p5Stream){
    return !!(ps && ps.ws && ps.ws.readyState === window.WebSocket.OPEN);
  }

  function cleanupSocket(ps){
    if (ps.ws) {
      try { ps.ws.onopen = ps.ws.onclose = ps.ws.onerror = ps.ws.onmessage = null; } catch { }
      try { ps.ws.close(); } catch { }
      ps.ws = null;
    }
  }

  function scheduleReconnect(ps){
    if (ps.reconnectTimer || !ps.wsAddress) return;
    const delay = clampPositive(ps.reconnectDelayMs, DEFAULT_STREAM_STATE.reconnectDelayMs);
    ps.reconnectTimer = setTimeout(() => {
      ps.reconnectTimer = null;
      openSocket(ps);
    }, delay);
  }

  function openSocket(ps){
    cleanupSocket(ps);
    if (!ps.wsAddress) {
      console.warn('[Sender] No WebSocket address provided');
      return;
    }
    try {
      ps.ws = new window.WebSocket(ps.wsAddress);
    } catch (err) {
      console.warn('[Sender] Failed to open WebSocket', err);
      scheduleReconnect(ps);
      return;
    }
    ps.ws.onopen = () => {
      console.log('[Sender] WebSocket opened');
      if (ps.reconnectTimer) {
        clearTimeout(ps.reconnectTimer);
        ps.reconnectTimer = null;
      }
    };
    ps.ws.onclose = (evt) => {
      console.log('[Sender] WebSocket closed', evt && evt.code, evt && evt.reason);
      cleanupSocket(ps);
      scheduleReconnect(ps);
    };
    ps.ws.onerror = (err) => {
      console.warn('[Sender] WebSocket error', err);
    };
    ps.ws.onmessage = (event) => {
      console.log('[Sender] Message from server:', event.data);
    };
  }

  function sendPixels(ps = window.p5Stream){
    if (!ps || !ps.targetUuid || !ps.targetWebviewuuid) return;
    if (!isSocketOpen(ps)) return;
    const now = (typeof performance !== 'undefined' && performance && typeof performance.now === 'function')
      ? performance.now()
      : Date.now();
    const targetFps = clampPositive(ps.targetFPS, DEFAULT_STREAM_STATE.targetFPS);
    const minInterval = 1000 / targetFps;
    if (ps.lastFrameSentAt > 0 && (now - ps.lastFrameSentAt) < minInterval) {
      return;
    }
    const deltaMs = ps.lastFrameSentAt > 0 ? Math.max(0, now - ps.lastFrameSentAt) : 0;
    const widthCandidates = [
      Number(window.width),
      Number(window._p5Instance?.width),
      Number(window._p5Instance?._renderer?.width),
      Number(window._renderer?.width),
      Number(window.drawingContext?.canvas?.width)
    ];
    const heightCandidates = [
      Number(window.height),
      Number(window._p5Instance?.height),
      Number(window._p5Instance?._renderer?.height),
      Number(window._renderer?.height),
      Number(window.drawingContext?.canvas?.height)
    ];
    const canvasWidth = widthCandidates.find((value) => typeof value === 'number' && value > 0) || 0;
    const canvasHeight = heightCandidates.find((value) => typeof value === 'number' && value > 0) || 0;
    if (!canvasWidth || !canvasHeight) {
      return;
    }

    if (ps.lossyEnabled) {
      const sent = sendLossyFrame(ps, canvasWidth, canvasHeight, deltaMs);
      if (sent) {
        ps.lastFrameSentAt = now;
        ps.lastKeyframeSentAt = now;
        return;
      }
    }

    if (typeof window.loadPixels === 'function') {
      try { window.loadPixels(); } catch { }
    }
    const pixelSource = (window.pixels instanceof Uint8ClampedArray)
      ? window.pixels
      : (Array.isArray(window.pixels) ? Uint8ClampedArray.from(window.pixels) : window.pixels);
    if (!pixelSource || !pixelSource.length) {
      return;
    }
    const current = pixelPool.acquire(pixelSource.length);
    current.set(pixelSource instanceof Uint8ClampedArray ? pixelSource : new Uint8ClampedArray(pixelSource));

    if (!ps.lastPixels) {
      transmitPayload(ps, { isFullFrame: true, pixels: current, width: canvasWidth, height: canvasHeight }, deltaMs);
      ps.lastPixels = current;
      ps.lastFrameSentAt = now;
      ps.lastKeyframeSentAt = now;
      return;
    }

    let diff = extractDirtyTiles(ps, current, ps.lastPixels, canvasWidth, canvasHeight);
    if (!diff) {
      pixelPool.release(ps.lastPixels);
      ps.lastPixels = current;
      return;
    }

    const keyframeInterval = clampPositive(ps.keyframeIntervalMs, DEFAULT_STREAM_STATE.keyframeIntervalMs);
    const lastKeyframe = ps.lastKeyframeSentAt || 0;
    const keyframeDue = keyframeInterval > 0 && (now - lastKeyframe) >= keyframeInterval;
    if (!diff.isFullFrame && keyframeDue) {
      diff = { isFullFrame: true, pixels: current, width: canvasWidth, height: canvasHeight };
    }

    transmitPayload(ps, diff, deltaMs);
    releaseDiffTiles(diff);
    pixelPool.release(ps.lastPixels);
    ps.lastPixels = current;
    ps.lastFrameSentAt = now;
    if (diff.isFullFrame) {
      ps.lastKeyframeSentAt = now;
    }
  }

  function sendLossyFrame(ps, canvasWidth, canvasHeight, deltaMs){
    const canvas = resolveCanvasElement();
    if (!canvas || typeof canvas.toDataURL !== 'function') {
      console.warn('[Sender] Unable to locate canvas for lossy streaming');
      return false;
    }
    const options = getLossyOptions();
    let dataUrl;
    try {
      dataUrl = canvas.toDataURL(options.mimeType, options.quality);
    } catch (err) {
      console.warn('[Sender] Failed to encode canvas', err);
      return false;
    }
    const payload = dataUrlToUint8Array(dataUrl);
    if (!payload.byteLength) {
      return false;
    }
    sendPayloadToTarget(ps, payload, null, true, deltaMs, canvasWidth, canvasHeight, {
      mimeType: options.mimeType,
      encoding: 'image',
      isLossy: true,
      quality: options.quality
    });
    return true;
  }

  function transmitPayload(ps, diff, deltaMs){
    if (!ps || !diff) return;
    if (!ps.targetUuid || !ps.targetWebviewuuid) return;
    if (diff.isFullFrame) {
      sendPayloadToTarget(ps, diff.pixels, null, true, deltaMs, diff.width, diff.height);
      return;
    }
    if (!Array.isArray(diff.tiles) || !diff.tiles.length) {
      return;
    }
    let firstTile = true;
    diff.tiles.forEach((tile) => {
      if (!tile || !tile.pixels) {
        return;
      }
      const tileDelta = firstTile ? deltaMs : 0;
      firstTile = false;
      sendPayloadToTarget(ps, tile.pixels, tile.region, false, tileDelta, diff.width, diff.height);
    });
  }

  function sendPayloadToTarget(ps, pixelsArray, region, isFullFrame, deltaMs, canvasWidth, canvasHeight, extraMetadata){
    if (!isSocketOpen(ps) || !pixelsArray) {
      return;
    }
    const typedPixels = toUint8ArrayView(pixelsArray);
    const header = {
      webviewuuid: ps.targetWebviewuuid,
      senderId: ps.senderId,
      uuid: ps.targetUuid,
      isFullFrame: !!isFullFrame,
      fullWidth: canvasWidth,
      fullHeight: canvasHeight,
      pixelLength: typedPixels.byteLength,
      deltaMs: normalizeDelta(ps, deltaMs)
    };
    if (region) {
      header.region = region;
    }
    if (extraMetadata && typeof extraMetadata === 'object') {
      Object.assign(header, extraMetadata);
    }
    const frame = buildBinaryFrame(header, typedPixels);
    try {
      if (ps.ws) {
        ps.ws.send(frame);
      }
    } catch (err) {
      console.warn('[Sender] Failed to send pixels', err);
    }
  }

  function normalizeDelta(ps, value){
    if (!Number.isFinite(value) || value < 0) {
      return 0;
    }
    return Math.min(2000, value);
  }

  function extractDirtyTiles(ps, current, previous, canvasWidth, canvasHeight){
    if (!previous || previous.length !== current.length) {
      return { isFullFrame: true, pixels: current, width: canvasWidth, height: canvasHeight };
    }
    const tileSize = clampPositive(ps.tileSize, DEFAULT_STREAM_STATE.tileSize);
    const maxRatio = (typeof ps.maxTileRatio === 'number')
      ? Math.min(Math.max(ps.maxTileRatio, 0.05), 1)
      : DEFAULT_STREAM_STATE.maxTileRatio;
    const maxCount = clampPositive(ps.maxTileCount, DEFAULT_STREAM_STATE.maxTileCount);
    const maxTileSendPerFrame = clampPositive(ps.maxTileSendPerFrame, DEFAULT_STREAM_STATE.maxTileSendPerFrame);
    const tilesX = Math.ceil(canvasWidth / tileSize);
    const tilesY = Math.ceil(canvasHeight / tileSize);
    const totalPixels = canvasWidth * canvasHeight;
    const changedTiles = [];
    let changedPixels = 0;
    for (let ty = 0; ty < tilesY; ty++) {
      for (let tx = 0; tx < tilesX; tx++) {
        const startX = tx * tileSize;
        const startY = ty * tileSize;
        const tileWidth = Math.min(tileSize, canvasWidth - startX);
        const tileHeight = Math.min(tileSize, canvasHeight - startY);
        if (tileWidth <= 0 || tileHeight <= 0) continue;
        if (tileIsDirty(current, previous, canvasWidth, startX, startY, tileWidth, tileHeight)) {
          const pixels = copyRegionPixels(current, canvasWidth, startX, startY, tileWidth, tileHeight);
          changedTiles.push({ region: { x: startX, y: startY, width: tileWidth, height: tileHeight }, pixels });
          changedPixels += tileWidth * tileHeight;
        }
      }
    }
    if (!changedTiles.length) {
      return null;
    }
    const changeRatio = changedPixels / totalPixels;
    if (changeRatio >= maxRatio || changedTiles.length > maxCount) {
      releaseDiffTiles({ tiles: changedTiles });
      return { isFullFrame: true, pixels: current, width: canvasWidth, height: canvasHeight };
    }
    if (changedTiles.length > maxTileSendPerFrame) {
      const merged = mergeTilesIntoBoundingRegion(changedTiles, current, canvasWidth, canvasHeight);
      if (merged) {
        releaseDiffTiles({ tiles: changedTiles });
        return { isFullFrame: false, tiles: [merged], width: canvasWidth, height: canvasHeight };
      }
    }
    return { isFullFrame: false, tiles: changedTiles, width: canvasWidth, height: canvasHeight };
  }

  function tileIsDirty(current, previous, canvasWidth, startX, startY, regionWidth, regionHeight){
    for (let y = 0; y < regionHeight; y++) {
      const baseIndex = ((startY + y) * canvasWidth + startX) * 4;
      for (let x = 0; x < regionWidth; x++) {
        const idx = baseIndex + x * 4;
        if (
          current[idx] !== previous[idx] ||
          current[idx + 1] !== previous[idx + 1] ||
          current[idx + 2] !== previous[idx + 2] ||
          current[idx + 3] !== previous[idx + 3]
        ) {
          return true;
        }
      }
    }
    return false;
  }

  function copyRegionPixels(sourcePixels, canvasWidth, startX, startY, regionWidth, regionHeight){
    const buffer = pixelPool.acquire(regionWidth * regionHeight * 4);
    const rowStride = regionWidth * 4;
    for (let row = 0; row < regionHeight; row++) {
      const srcIndex = ((startY + row) * canvasWidth + startX) * 4;
      const destIndex = row * rowStride;
      buffer.set(sourcePixels.subarray(srcIndex, srcIndex + rowStride), destIndex);
    }
    return buffer;
  }

  function mergeTilesIntoBoundingRegion(tiles, sourcePixels, canvasWidth, canvasHeight){
    if (!Array.isArray(tiles) || !tiles.length) {
      return null;
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    tiles.forEach((tile) => {
      if (!tile || !tile.region) {
        return;
      }
      const { x = 0, y = 0, width = 0, height = 0 } = tile.region;
      if (width <= 0 || height <= 0) {
        return;
      }
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + width);
      maxY = Math.max(maxY, y + height);
    });
    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
      return null;
    }
    const mergedWidth = Math.max(1, Math.min(canvasWidth, Math.floor(maxX - minX)));
    const mergedHeight = Math.max(1, Math.min(canvasHeight, Math.floor(maxY - minY)));
    if (!mergedWidth || !mergedHeight) {
      return null;
    }
    const originX = Math.max(0, Math.floor(minX));
    const originY = Math.max(0, Math.floor(minY));
    const pixels = copyRegionPixels(sourcePixels, canvasWidth, originX, originY, mergedWidth, mergedHeight);
    return {
      region: {
        x: originX,
        y: originY,
        width: mergedWidth,
        height: mergedHeight
      },
      pixels
    };
  }

  function releaseDiffTiles(diff){
    if (!diff || diff.isFullFrame || !Array.isArray(diff.tiles)) {
      return;
    }
    diff.tiles.forEach((tile) => {
      if (tile && tile.pixels) {
        pixelPool.release(tile.pixels);
      }
    });
  }

  function toUint8ArrayView(source){
    if (source instanceof Uint8Array) {
      return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
    }
    if (source instanceof Uint8ClampedArray) {
      return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
    }
    if (Array.isArray(source)) {
      return Uint8Array.from(source);
    }
    if (source && typeof source.buffer === 'object') {
      try {
        return new Uint8Array(source.buffer, source.byteOffset || 0, source.byteLength || source.length || 0);
      } catch (err) {
        return new Uint8Array(0);
      }
    }
    return new Uint8Array(0);
  }

  function buildBinaryFrame(metadata, pixelArray){
    const headerJson = JSON.stringify(metadata);
    const headerBytes = textEncoder ? textEncoder.encode(headerJson) : fallbackEncode(headerJson);
    const totalBytes = 4 + headerBytes.length + pixelArray.byteLength;
    const buffer = new ArrayBuffer(totalBytes);
    const view = new DataView(buffer);
    view.setUint32(0, headerBytes.length, false);
    const headerDest = new Uint8Array(buffer, 4, headerBytes.length);
    headerDest.set(headerBytes);
    if (pixelArray.byteLength) {
      const pixelDest = new Uint8Array(buffer, 4 + headerBytes.length, pixelArray.byteLength);
      pixelDest.set(pixelArray);
    }
    return buffer;
  }

  function fallbackEncode(str){
    const arr = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) {
      arr[i] = str.charCodeAt(i) & 0xff;
    }
    return arr;
  }

  const enableLossySendInvoker = function(arg1, arg2) {
    const ps = window.p5Stream;
    const parsed = parseLossyArgs(arg1, arg2) || {};
    if (parsed.quality !== undefined || parsed.mimeType) {
      updateLossyOptions(parsed);
    }
    setLossyEnabled(ps, true);
  };

  enableLossySendInvoker.disable = function() {
    setLossyEnabled(window.p5Stream, false);
  };

  Object.defineProperty(window, 'enableLossySend', {
    configurable: false,
    enumerable: true,
    get() {
      return enableLossySendInvoker;
    },
    set(value) {
      setLossyEnabled(window.p5Stream, Boolean(value));
    }
  });

  Object.defineProperty(window, 'lossySendOptions', {
    configurable: false,
    enumerable: true,
    get() {
      return Object.assign({}, getLossyOptions());
    },
    set(value) {
      if (value && typeof value === 'object') {
        updateLossyOptions(value);
      }
    }
  });

  window.disableLossySend = function(){
    setLossyEnabled(window.p5Stream, false);
  };

  window.connectStream = function(wsAddress, streamId, userCode, targetFPS) {
    pixelDensity(1); // Ensure pixelDensity is 1 for consistent pixel data
    const ps = window.p5Stream;
    ps.wsAddress = wsAddress;
    ps.targetWebviewuuid = streamId;
    ps.targetUuid = userCode;
    ps.lastFrameSentAt = 0;
    ps.lastKeyframeSentAt = 0;
    const desiredFPS = (typeof targetFPS === 'number') ? targetFPS : DEFAULT_STREAM_STATE.targetFPS;
    ps.targetFPS = clampPositive(desiredFPS, DEFAULT_STREAM_STATE.targetFPS);
    if (ps.lastPixels) {
      pixelPool.release(ps.lastPixels);
      ps.lastPixels = null;
    }
    openSocket(ps);
  };

  window.sendPixels = function() {
    sendPixels(window.p5Stream);
  };
})();
// --- Custom context menu for "Save As png..." and "Copy image" on canvas ---
(function() {
  // Inject style for custom context menu hover effect
  if (!document.getElementById('p5-custom-menu-style')) {
    const style = document.createElement('style');
    style.id = 'p5-custom-menu-style';
  style.textContent = \`
      .p5-custom-context-menu {
        position: fixed;
        background: #1F1F1F;
        color: #cccccc;
        padding: 0;
        border: 2px solid #454545;
        border-radius: 8px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.3);
        z-index: 10001;
        font-family: monospace;
        user-select: none;
     min-width: 120px;
        overflow: hidden;
      }
      .p5-custom-context-menu-item {
        padding: 5px 16px;
        cursor: pointer;
        transition: background 0.15s, color 0.15s;
        border-radius: 5px;
        margin: 1px 2px;
        font-size: 13px;
      }
      .p5-custom-context-menu-item:hover {
        background: #0078D4 !important;
        color: #fff !important;
      }
  \`;
    document.head.appendChild(style);
  }
  let customMenu = null;
  function clampMenuToViewport(menuEl, clientX, clientY) {
    try {
      if (!menuEl) return;
      const margin = 8;
      const vw = window.innerWidth || 0;
      const vh = window.innerHeight || 0;
      // Start at the click position
      let left = Number(clientX) || 0;
      let top = Number(clientY) || 0;
      // Measure after being in DOM (visibility hidden is fine)
      const rect = menuEl.getBoundingClientRect();
      if (vw > 0) {
        if (left + rect.width > vw - margin) left = Math.max(margin, vw - rect.width - margin);
        if (left < margin) left = margin;
      }
      if (vh > 0) {
        if (top + rect.height > vh - margin) top = Math.max(margin, vh - rect.height - margin);
        if (top < margin) top = margin;
      }
      menuEl.style.left = left + 'px';
      menuEl.style.top = top + 'px';
    } catch { }
  }

  let _menuResizeHandler = null;
  document.addEventListener('contextmenu', function(e) {
    // Only show on canvas (p5Canvas)
    const canvas = e.target && e.target.classList && e.target.classList.contains('p5Canvas') ? e.target : null;
    if (!canvas) return;
    e.preventDefault();
    // Remove any existing menu
    if (customMenu) customMenu.remove();
    customMenu = document.createElement('div');
    customMenu.className = 'p5-custom-context-menu';
    customMenu.style.left = e.clientX + 'px';
    customMenu.style.top = e.clientY + 'px';
    // Hide until clamped into the viewport
    customMenu.style.visibility = 'hidden';

    // Helper: get a PNG dataUrl of the canvas at its display size (not upscaled by CSS)
    function getCanvasDataUrlAtDisplaySize() {
      // If canvas width/height != clientWidth/clientHeight, draw to a temp canvas at display size
      const c = canvas;
      const cssW = c.clientWidth;
      const cssH = c.clientHeight;
      const pxW = c.width;
      const pxH = c.height;
      if (pxW === cssW && pxH === cssH) {
        return c.toDataURL('image/png');
      }
      // Downscale to display size
      const tmp = document.createElement('canvas');
      tmp.width = cssW;
      tmp.height = cssH;
      const ctx = tmp.getContext('2d');
      ctx.drawImage(c, 0, 0, pxW, pxH, 0, 0, cssW, cssH);
      return tmp.toDataURL('image/png');
    }

    // Save as png...
    const saveItem = document.createElement('div');
    saveItem.className = 'p5-custom-context-menu-item';
    saveItem.textContent = 'Save as png...';
    saveItem.addEventListener('mousedown', function(ev) { ev.stopPropagation(); ev.preventDefault(); });
    saveItem.addEventListener('click', function() {
      try {
        const dataUrl = getCanvasDataUrlAtDisplaySize();
        // Use the sketch filename (without extension) if available
        let fileName = (window._p5SketchFileName || '').replace(/\.[^.]+$/, '') || 'sketch';
        fileName = fileName + '.png';
        vscode.postMessage({ type: 'saveCanvasImage', dataUrl, fileName });
      } catch (err) {
        vscode.postMessage({ type: 'showError', message: 'Failed to export image: ' + err });
      }
      customMenu.remove();
    });

    // Copy image
    const copyItem = document.createElement('div');
    copyItem.className = 'p5-custom-context-menu-item';
    copyItem.textContent = 'Copy image';
    copyItem.addEventListener('mousedown', function(ev) { ev.stopPropagation(); ev.preventDefault(); });
    copyItem.addEventListener('click', async function() {
      try {
        const dataUrl = getCanvasDataUrlAtDisplaySize();
        // Try using Clipboard API if available
  if (navigator.clipboard && window.ClipboardItem) {
          const res = await fetch(dataUrl);
          const blob = await res.blob();
          const item = new window.ClipboardItem({ 'image/png': blob });
          await navigator.clipboard.write([item]);
          // Show notification in webview (since VSCode API not available here)
          var cssW = canvas.clientWidth;
          var cssH = canvas.clientHeight;
          vscode.postMessage({ type: 'showInfo', message: 'Canvas image copied to clipboard (' + cssW + ' x ' + cssH + ')' });
        } else {
          vscode.postMessage({ type: 'copyCanvasImage', dataUrl });
        }
      } catch (err) {
        vscode.postMessage({ type: 'showError', message: 'Failed to copy image: ' + err });
      }
      customMenu.remove();
    });

    const refreshItem = document.createElement('div');
    refreshItem.className = 'p5-custom-context-menu-item';
    refreshItem.textContent = 'Refresh';
    refreshItem.addEventListener('mousedown', function(ev) { ev.stopPropagation(); ev.preventDefault(); });
    refreshItem.addEventListener('click', function() {
      try { vscode.postMessage({ type: 'context-menu-refresh' }); } catch { }
      customMenu.remove();
    });

    const pauseState = !!window._p5LoopPaused;
    const pauseItem = document.createElement('div');
    pauseItem.className = 'p5-custom-context-menu-item';
    pauseItem.textContent = pauseState ? 'Resume draw loop' : 'Pause draw loop';
    pauseItem.addEventListener('mousedown', function(ev) { ev.stopPropagation(); ev.preventDefault(); });
    pauseItem.addEventListener('click', function() {
      try { vscode.postMessage({ type: 'context-menu-toggle-pause', pause: !pauseState }); } catch { }
      customMenu.remove();
    });

    const captureVisible = !!window._p5CaptureVisible;
    const recordItem = document.createElement('div');
    recordItem.className = 'p5-custom-context-menu-item';
    recordItem.textContent = captureVisible ? 'Hide capture panel' : 'Show capture panel';
    recordItem.addEventListener('mousedown', function(ev) { ev.stopPropagation(); ev.preventDefault(); });
    recordItem.addEventListener('click', function() {
      try { vscode.postMessage({ type: 'context-menu-toggle-capture' }); } catch { }
      customMenu.remove();
    });

    const fpsEl = document.getElementById('fps-indicator');
    const fpsVisible = !!(fpsEl && fpsEl.style && fpsEl.style.display !== 'none');
    const fpsItem = document.createElement('div');
    fpsItem.className = 'p5-custom-context-menu-item';
    fpsItem.textContent = fpsVisible ? 'Hide FPS' : 'Show FPS';
    fpsItem.addEventListener('mousedown', function(ev) { ev.stopPropagation(); ev.preventDefault(); });
    fpsItem.addEventListener('click', function() {
      try { vscode.postMessage({ type: 'context-menu-toggle-fps', show: !fpsVisible }); } catch { }
      customMenu.remove();
    });

    customMenu.appendChild(saveItem);
    customMenu.appendChild(copyItem);
    customMenu.appendChild(refreshItem);
    customMenu.appendChild(pauseItem);
    customMenu.appendChild(recordItem);
    customMenu.appendChild(fpsItem);
    document.body.appendChild(customMenu);

    // Avoid "shrink-to-fit" width when positioned near the right/bottom edge:
    // measure once with plenty of space, then freeze the width and only move.
    try {
      customMenu.style.width = '';
      customMenu.style.left = '8px';
      customMenu.style.top = '8px';
      const rect = customMenu.getBoundingClientRect();
      if (rect && rect.width > 0) {
        customMenu.style.width = rect.width + 'px';
      }
    } catch { }

    // Clamp into the visible webview bounds
    clampMenuToViewport(customMenu, e.clientX, e.clientY);
    customMenu.style.visibility = '';

    // Keep it clamped if the webview is resized while open
    _menuResizeHandler = function() {
      try { if (customMenu) clampMenuToViewport(customMenu, parseFloat(customMenu.style.left || '0'), parseFloat(customMenu.style.top || '0')); } catch { }
    };
    try { window.addEventListener('resize', _menuResizeHandler); } catch { }

    // Remove menu on click elsewhere or escape
    function removeMenu() {
      if (customMenu) {
        customMenu.remove();
        customMenu = null;
      }
      try {
        if (_menuResizeHandler) window.removeEventListener('resize', _menuResizeHandler);
      } catch { }
      _menuResizeHandler = null;
    }
    setTimeout(() => {
  document.addEventListener('mousedown', removeMenu, { once: true });
  document.addEventListener('keydown', function esc(ev) { if (ev && ev.key === 'Escape') { removeMenu(); document.removeEventListener('keydown', esc); } });
    }, 0);
  });
})();
</script>
<script>
${loopGuardHelperScript}
</script>
<style>
:root { --overlay-font-size: ${editorFontSize}px; --toolbar-scale: 1.5; }
html,body{margin:0;padding:0;overflow:hidden;width:100%;height:100%;background:transparent;}
canvas.p5Canvas{
  display:block;
  /* --- Add drop shadow below --- */
  box-shadow: 0 4px 24px 0 rgba(0,0,0,0.35);
}
#error-overlay{
  position:fixed; top:0; left:0; right:0; bottom:0;
  background: #1f1f1f; color:#f22268; font-family:monospace; padding:10px; font-size: var(--overlay-font-size);
  display:none; z-index: 9999; white-space:pre-wrap; overflow:auto;
}
/* Warning overlay (yellow text) */
#warning-overlay{
  position:fixed; top:0; left:0; right:0; bottom:0;
  background: #1f1f1f; color:#ffeb3b; font-family:monospace; padding:10px; font-size: var(--overlay-font-size);
  display:none; z-index: 9998; white-space:pre-wrap; overflow:auto;
}
/* Warning overlay (yellow text) */
#warning-overlay{
  position:fixed; top:0; left:0; right:0; bottom:0;
  background: #1f1f1f; color:#ffeb3b; font-family:monospace; padding:10px;
  display:none; z-index: 9998; white-space:pre-wrap; overflow:auto;
}
/* Inputs overlay */
#inputs-overlay{
  position:fixed; top:0; left:0; right:0; bottom:0;
  background: rgba(0,0,0,0.7); color:#fff; font-family:monospace; padding:16px;
  display:none; z-index: 10002; overflow:auto;
}
#inputs-overlay .panel{
  max-width: 520px; margin: 40px auto; background:#1f1f1f; border:1px solid #444; border-radius:8px; padding:16px;
  box-shadow: 0 4px 24px rgba(0,0,0,0.4);
}
#inputs-overlay h2{ margin:0 0 8px 0; font-size: 18px; }
#inputs-overlay p{ margin:0 0 12px 0; color:#ddd; }
#inputs-overlay .input-row{ display:flex; align-items:center; gap:8px; margin:6px 0; }
#inputs-overlay .input-row label{ width: 180px; text-align:right; color:#ddd; }
#inputs-overlay .input-row input[type="text"],
#inputs-overlay .input-row input[type="number"]{
  flex:1; padding:6px 8px; border-radius:4px; border:1px solid #555; background:#222; color:#fff;
}
#inputs-overlay .buttons{ display:flex; justify-content:flex-end; gap:8px; margin-top:14px; }
#inputs-overlay button{ padding:6px 10px; border-radius:4px; border:1px solid #555; background:#2b2b2b; color:#fff; cursor:pointer; }
#inputs-overlay button.primary{ background:#0078D4; border-color:#0078D4; }
#inputs-overlay button:hover{ filter: brightness(1.1); }

#p5-toolbar { /* removed toolbar */ }
/* FPS indicator */
#fps-indicator {
  position: fixed;
  top: 10px;
  left: 10px;
  z-index: 10004;
  background: rgba(0,0,0,0.6);
  color: #fff;
  font-family: monospace;
  font-size: 12px;
  padding: 2px 6px;
  border-radius: 4px;
  user-select: none;
  pointer-events: none; /* don't block clicks */
  display: none;
}
#p5-var-controls {
  position: fixed;
  left: 0; right: 0; bottom: 0;
  background: #1f1f1f;
  z-index: 10000;
  padding: 4px 12px 2px 12px;
  font-family: monospace;
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 4px 10px;
  max-height: calc(3 * 2.0em);
  overflow-y: auto;
  transition: transform 0.2s cubic-bezier(.4,0,.2,1), box-shadow 0.2s;
  box-shadow: 0 -2px 8px rgba(0,0,0,0.2);
}
#p5-var-controls.drawer-hidden {
  transform: translateY(100%);
  box-shadow: none;
}
#p5-var-controls .drawer-toggle {
  position: absolute;
  top: 4px;
  right: 4px;
  background: none;
  border: none;
  color: #fff;
  font-size: 16px;
  cursor: pointer;
  z-index: 10001;
  padding: 2px 4px;
  transition: color 0.2s;
}
#p5-var-controls .drawer-toggle:hover {
  color: #ff0;
}
#p5-var-drawer-tab {
  display: none;
  position: fixed;
  right: 0px;
  bottom: 0;
  background: #1f1f1f;
  color: #fff;
  border-radius: 6px 0px 0px 0px;
  padding: 0px 4px 2px 4px;
  font-family: monospace;
  font-size: 20px;
  z-index: 10001;
  box-shadow: 0 -2px 8px rgba(0,0,0,0.2);
  cursor: pointer;
  min-width: 24px;
  min-height: 28px;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transform: translateY(100%);
  transition: opacity 0.2s cubic-bezier(.4,0,.2,1), transform 0.2s cubic-bezier(.4,0,.2,1);
}
#p5-var-drawer-tab.tab-visible {
  display: flex !important;
  opacity: 1;
  transform: translateY(0%);
}
</style>
</head>
<body>
<div id="error-overlay"></div>
<div id="warning-overlay"></div>
<div id="fps-indicator" style="display:${showFPS ? 'block' : 'none'}"></div>
<div id="inputs-overlay" aria-hidden="true">
  <div class="panel">
    <h2>Sketch inputs</h2>
    <p>Enter values for top-of-sketch inputs before running.</p>
    <div id="inputs-container"></div>
    <div class="buttons">
      <button id="inputs-submit" class="primary" disabled>Run</button>
    </div>
  </div>
  </div>
<!-- In-webview toolbar removed; actions are now provided via editor title bar buttons -->
<script>
// --- Prevent default VSCode context menu except on canvas ---
document.addEventListener('contextmenu', function(e) {
  // Allow context menu only on canvas with class 'p5Canvas'
  if (!(e.target && e.target.classList && e.target.classList.contains('p5Canvas'))) {
    e.preventDefault();
  }
});
</script>
<script>
// Capture visibility toggle (no in-webview toolbar)
(function() {
  window._p5CaptureVisible = ${initialCaptureVisible ? 'true' : 'false'};
  // Reset capture UI/timer by removing existing containers
  function resetCaptureUIAndTimer() {
    try {
      const containers = document.querySelectorAll('.p5c-container');
      containers.forEach(el => el.remove());
      if (typeof window._applyCaptureVisibility === 'function') {
        try { window._applyCaptureVisibility(); } catch {}
      }
    } catch {}
  }
  function applyCaptureVisibility() {
    try {
      // Remove any duplicate capture panel before showing/hiding
      const containers = document.querySelectorAll('.p5c-container');
      if (containers.length > 1) {
        // Keep the first, remove the rest
        for (let i = 1; i < containers.length; i++) {
          containers[i].remove();
        }
      }
      const div = document.querySelector('.p5c-container');
      if (div) div.style.display = window._p5CaptureVisible ? '' : 'none';
    } catch {}
  }
  // Observe DOM to apply visibility when capture DOM appears
  const obs = new MutationObserver(applyCaptureVisibility);
  obs.observe(document.body, { childList: true, subtree: true });
  window._applyCaptureVisibility = applyCaptureVisibility;
  // On reload, remove all but one capture panel if any exist
  document.addEventListener('DOMContentLoaded', function() {
    const containers = document.querySelectorAll('.p5c-container');
    if (containers.length > 1) {
      for (let i = 1; i < containers.length; i++) {
        containers[i].remove();
      }
    }
  });
  // Expose reset helper
  window._resetCaptureUIAndTimer = resetCaptureUIAndTimer;
  // Apply initial visibility on load
  try { applyCaptureVisibility(); } catch {}
})();
</script>
<script>
// --- Provide MEDIA_FOLDER global for user sketches ---
const MEDIA_FOLDER = ${JSON.stringify(mediaWebviewUriPrefix)};
const vscode = acquireVsCodeApi();
if (!window._p5CaptureRecordResumeHookInstalled) {
  try { window._p5CaptureRecordResumeHookInstalled = true; } catch {}
  document.addEventListener('click', function handleCaptureRecordClick(ev) {
    try {
      const target = (ev && ev.target && typeof ev.target === 'object' && ev.target) ? ev.target : null;
      const recordButton = target && typeof target.closest === 'function' ? target.closest('.p5c-btn') : null;
      if (!recordButton) return;
      if (!window._p5LoopPaused) return;
      vscode.postMessage({ type: 'context-menu-toggle-pause', pause: false });
    } catch {}
  }, true);
}
window._p5Instance = null;
window._p5UserDefinedCanvas = false;
window._p5UserAutoFill = false;
window._p5UserBackground = false;
window._p5LastBackgroundArgs = null;
window._p5ErrorLogged = false;
window._p5ErrorActive = false;

// Debounce utility for webview
function debounceWebview(fn, delay) {
  let timeout;
  return function(...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn.apply(this, args), delay);
  };
}
window._p5DebounceDelay = ${debounceDelay};
window._p5VarControlDebounceDelay = ${varControlDebounceDelay};

// Notify extension that webview is loaded
window.addEventListener('DOMContentLoaded', () => {
  vscode.postMessage({ type: 'webviewLoaded' });
  // Ensure capture toggle icon matches preserved visibility state after reload
  try { vscode.postMessage({ type: 'captureVisibilityChanged', visible: !!window._p5CaptureVisible }); } catch {}
});

function showError(msg){
  window._p5ErrorActive = true;
  const el = document.getElementById("error-overlay");
  if(el){
    // Render as DOM so we can optionally add an action link for loop-guard errors.
    while (el.firstChild) { try { el.removeChild(el.firstChild); } catch { break; } }
    const msgEl = document.createElement('div');
    msgEl.textContent = msg;
    el.appendChild(msgEl);

    try {
      const isLoopGuard = !!window.__p5LoopGuardActive
        && typeof msg === 'string'
        && msg.indexOf('Potential infinite loop detected') !== -1;
      if (isLoopGuard) {
        try {
          const cfg = (window && window.__p5LoopGuardConfig) || {};
          const enabled = (cfg && typeof cfg.enabled === 'boolean') ? cfg.enabled : undefined;
          const maxIterations = (cfg && typeof cfg.maxIterations === 'number') ? cfg.maxIterations : undefined;
          const maxTimeMs = (cfg && typeof cfg.maxTimeMs === 'number') ? cfg.maxTimeMs : undefined;
          const cfgLine = document.createElement('div');
          cfgLine.textContent = 'maxIterations=' + maxIterations + ', maxTimeMs=' + maxTimeMs;
          el.appendChild(cfgLine);
        } catch {}

        const linkWrap = document.createElement('div');
        const a = document.createElement('a');
        a.href = '#';
        a.textContent = 'Edit loop guard settings to allow for longer loops';
        try { a.style.textDecoration = 'underline'; a.style.cursor = 'pointer'; } catch {}
        a.addEventListener('click', (ev) => {
          try { ev.preventDefault(); } catch {}
          try { vscode.postMessage({ type: 'openLoopGuardSettings' }); } catch {}
        });
        linkWrap.appendChild(a);
        el.appendChild(linkWrap);
      }
    } catch {}

    el.style.display = "block";
  }
  try {
    window.__p5LoopGuardActive = !!window.__p5LoopGuardActive;
    window.__p5LoopGuardMsg = msg || '';
  } catch {}
  safeRemoveP5Instance();
  document.querySelectorAll("canvas").forEach(c=>c.remove());
  // Prevent p5.js from calling user draw/setup again
  window.draw = undefined;
  window.setup = undefined;
}
function clearError(){
  window._p5ErrorActive = false;
  const el=document.getElementById("error-overlay");
  if(el){el.textContent=""; el.style.display="none";}
  const wl=document.getElementById("warning-overlay");
  if(wl){wl.textContent=""; wl.style.display="none";}
}
function showWarning(msg){
  const wl = document.getElementById('warning-overlay');
  if (wl) { wl.textContent = msg; wl.style.display = 'block'; }
}
window.__p5HandleLoopGuardHit = function(tag, rawMessage) {
  const base = (typeof rawMessage === 'string' && rawMessage.trim().length > 0)
    ? rawMessage.trim()
    : ('Potential infinite loop detected' + (tag ? ' near ' + tag : '') + '.');
  const msg = base.startsWith('[‼️RUNTIME ERROR]') ? base : '[‼️RUNTIME ERROR] ' + base;
  try { window.__p5LoopGuardActive = true; window.__p5LoopGuardMsg = msg; } catch {}
  showError(msg);
  try {
    vscode.postMessage({ type: 'loopGuardHit', message: msg });
  } catch {}
  try { vscode.postMessage({ type: 'showError', message: msg }); } catch {}
};
// Suppress benign internal p5 error that can appear after another error
function _p5ShouldSuppressError(raw){
  try{
    const msg = (raw==null?"":String(raw));
    // Check both with and without our [RUNTIME ERROR] prefix
    return /(^|\s)\[?‼️RUNTIME ERROR\]?\s*this\._decrementPreload is not a function/i.test(msg)
      || /this\._decrementPreload is not a function/i.test(msg)
      || /_decrementPreload/.test(msg);
  }catch{ return false; }
}

(function(){
  const origLog = console.log;
  console.log = function(...args){
    // If OSC output was just shown, a sketch log should switch back to the sketch output channel.
    try { vscode.postMessage({ type: "log", message: args, focus: true }); } catch { }
    origLog.apply(console, args);
  };
  window.output = function(...args){
    try { vscode.postMessage({ type: "log", message: args, focus: true }); } catch { }
    origLog.apply(console, args);
  };
  function describeResourceErrorFromEvent(ev) {
    try {
      const target = ev && (ev.target || ev.currentTarget);
      if (!target || (typeof target !== 'object')) return null;
      const tagName = typeof target.tagName === 'string' ? target.tagName.toLowerCase() : undefined;
      const attrSrc = typeof target.getAttribute === 'function'
        ? (target.getAttribute('src') || target.getAttribute('href'))
        : undefined;
      let rawResource = attrSrc || target.src || target.href;
      if (!rawResource || typeof rawResource !== 'string') {
        return tagName ? ('Failed to load ' + tagName + ' resource (unknown URL).') : null;
      }
      let displayResource = rawResource;
      try {
        const parsed = new URL(rawResource, window.location.href);
        // Prefer original attribute when available so relative paths stay recognizable
        displayResource = attrSrc || parsed.pathname || parsed.href;
      } catch {
        // Fallback: trim query/hash for readability
        const clean = rawResource.split('?')[0].split('#')[0];
        if (clean) displayResource = clean;
      }
      if (displayResource.startsWith('vscode-webview://') || displayResource.startsWith('vscode-resource://')) {
        // Extract trailing segment to avoid noisy authority details
        const parts = displayResource.split('/');
        if (parts.length > 1) {
          const tail = parts.filter(Boolean).slice(-3).join('/');
          if (tail) displayResource = tail;
        }
      }
      if (tagName === 'img') {
        return 'Failed to load image resource: ' + displayResource + '. Check that the file exists and the path is correct.';
      }
      if (tagName === 'script') {
        return 'Failed to load script resource: ' + displayResource + '.';
      }
      if (tagName === 'link') {
        return 'Failed to load stylesheet resource: ' + displayResource + '.';
      }
      return 'Failed to load resource' + (tagName ? ' (' + tagName + ')' : '') + ': ' + displayResource + '.';
    } catch {
      return null;
    }
  }

  function formatErrorArgument(arg) {
    if (typeof arg === 'string') return arg;
    if (arg == null) return '';
    if (Object.prototype.toString.call(arg) === '[object Arguments]') {
      return Array.prototype.join.call(arg, ' ');
    }
    if (typeof ErrorEvent !== 'undefined' && arg instanceof ErrorEvent) {
      if (arg.message) return arg.message;
    }
    if (arg instanceof Error) {
      return arg.message || arg.name;
    }
    if (typeof Event !== 'undefined' && arg instanceof Event) {
      const detail = describeResourceErrorFromEvent(arg);
      if (detail) return detail;
      return arg.type ? ('Runtime event error (' + arg.type + ')') : 'Runtime event error';
    }
    if (typeof arg === 'object') {
      try {
        return JSON.stringify(arg);
      } catch {
        if (arg && typeof arg.toString === 'function' && arg.toString !== Object.prototype.toString) {
          try { return arg.toString(); } catch { /* ignore */ }
        }
      }
    }
    return String(arg);
  }

  const origErr=console.error;
  console.error=function(...args){
    // Always prefix with [‼️RUNTIME ERROR] and stringify arguments, including Arguments objects and Error objects
    const parts = args.map(formatErrorArgument).filter(part => part != null && String(part).length > 0);
    let msg = parts.length > 0 ? parts.join(' ') : '';
    if (!msg) {
      msg = args.map(a => (a && a.toString ? a.toString() : String(a))).join(' ');
    }
    if (window.__p5LoopGuardActive && typeof msg === 'string' && msg.indexOf('Potential infinite loop detected') !== -1) {
      origErr.apply(console,args);
      return;
    }
    // Suppress only the specific benign p5 internal error
    if (_p5ShouldSuppressError(msg)) { origErr.apply(console,args); return; }
    if (!msg.startsWith("[RUNTIME ERROR]")) {
      msg = "[‼️RUNTIME ERROR] " + msg;
    }
    showError(msg); // Always show in overlay
    vscode.postMessage({type:"showError",message:msg}); // Always log in output
    origErr.apply(console,args);
  }
})();

window.onerror = function(message, source, lineno, colno, error) {
  let msg = message && message.toString ? message.toString() : String(message);
  // Normalize the noisy appendChild/SyntaxError into a clearer message
  if (msg && msg.indexOf("Failed to execute 'appendChild' on 'Node': Invalid or unexpected token") !== -1) {
    msg = 'Uncaught SyntaxError: Invalid or unexpected character';
  }
  if (_p5ShouldSuppressError(msg)) {
    // Let it go to the browser console but do not show overlay or VS Code output
    return false;
  }
  if (window.__p5LoopGuardActive && typeof msg === 'string' && msg.indexOf('Potential infinite loop detected') !== -1) {
    return false;
  }
  if (!msg.startsWith('[RUNTIME ERROR]')) {
    msg = '[‼️RUNTIME ERROR] ' + msg;
  }
  let extractedLine = lineno;
  if (error && error.stack) {
    const sketchFileName = window._p5SketchFileName || 'sketch';
    const regex = new RegExp(sketchFileName + '\\\\.js:(\\\\d+)');
    const match = error.stack.match(regex);
    if (match) {
      extractedLine = parseInt(match[1], 10);
    }
  }
  if (extractedLine !== undefined && extractedLine !== 0) {
    msg += ' (line ' + extractedLine + ')';
  }
  showError(msg);
  try {
    vscode.postMessage({ type: 'showError', message: msg });
  } catch {}
  return false;
};

// --- Add this handler for unhandled promise rejections ---
window.onunhandledrejection = function(event) {
  let msg = '';
  if (event && event.reason) {
    if (typeof event.reason === 'string') {
      msg = event.reason;
    } else if (event.reason && event.reason.message) {
      msg = event.reason.message;
    } else {
      try { msg = JSON.stringify(event.reason); } catch { msg = String(event.reason); }
    }
  } else {
    msg = 'Unhandled promise rejection';
  }
  if (window.__p5LoopGuardActive && typeof msg === 'string' && msg.indexOf('Potential infinite loop detected') !== -1) {
    return;
  }
  if (_p5ShouldSuppressError(msg)) {
    return; // do not show overlay or postMessage for this specific error
  }
  if (!msg.startsWith('[‼️RUNTIME ERROR]')) {
    msg = '[‼️RUNTIME ERROR] ' + msg;
  }
  showError(msg);
  vscode.postMessage({ type: 'showError', message: msg });
  // Prevent default logging to console (optional)
  // event.preventDefault();
};

function safeRemoveP5Instance(){
  if(!window._p5Instance) return;
  try{
    const inst=window._p5Instance;
    if(inst && typeof inst.remove === 'function') inst.remove();
  }catch(err){
    try{console.warn('p5 remove() failed', err);}catch{}
  }
  try{window._p5Instance=null;}catch{}
}

function runUserSketch(code){
  clearError();
  window._p5ErrorLogged = false;
  window._p5SetupDone = false;
  window._p5PostedAfterSetup = false;
  // Reset cached background replay state to avoid stale/no-arg background() calls after debug transitions.
  window._p5UserBackground = false;
  window._p5LastBackgroundArgs = null;
  const pendingLoopState = (typeof window._p5PendingLoopPaused === 'boolean')
    ? window._p5PendingLoopPaused
    : (typeof window._p5LoopPaused === 'boolean' ? window._p5LoopPaused : false);
  window._p5PendingLoopPaused = undefined;
  window._p5LoopPaused = !!pendingLoopState;
  safeRemoveP5Instance();
  document.querySelectorAll("canvas").forEach(c=>c.remove());

  if (typeof window.__p5ResetLoopGuards === 'function') {
    try { window.__p5ResetLoopGuards(); } catch {}
  }
  try { window.__p5LoopGuardActive = false; window.__p5LoopGuardMsg = ''; } catch {}

  // Execute user code in an isolated function scope to avoid global re-declaration errors on refresh.
  const executableCode =
    '(function(){\\n' +
    // Clear previous handlers so removed functions don't persist across reloads.
    'window.preload = undefined;\\n' +
    'window.setup = undefined;\\n' +
    'window.draw = undefined;\\n' +
    'window.windowResized = undefined;\\n' +
    'window.mouseMoved = undefined;\\n' +
    'window.mouseDragged = undefined;\\n' +
    'window.mousePressed = undefined;\\n' +
    'window.mouseReleased = undefined;\\n' +
    'window.mouseClicked = undefined;\\n' +
    'window.doubleClicked = undefined;\\n' +
    'window.mouseWheel = undefined;\\n' +
    'window.touchStarted = undefined;\\n' +
    'window.touchMoved = undefined;\\n' +
    'window.touchEnded = undefined;\\n' +
    'window.keyPressed = undefined;\\n' +
    'window.keyReleased = undefined;\\n' +
    'window.keyTyped = undefined;\\n' +
    'window.deviceMoved = undefined;\\n' +
    'window.deviceTurned = undefined;\\n' +
    'window.deviceShaken = undefined;\\n' +
    code + '\\n' +
    // Re-export local hook functions declared in sketch scope.
    'window.preload = (typeof preload === "function") ? preload : window.preload;\\n' +
    'window.setup = (typeof setup === "function") ? setup : window.setup;\\n' +
    'window.draw = (typeof draw === "function") ? draw : window.draw;\\n' +
    'window.windowResized = (typeof windowResized === "function") ? windowResized : window.windowResized;\\n' +
    'window.mouseMoved = (typeof mouseMoved === "function") ? mouseMoved : window.mouseMoved;\\n' +
    'window.mouseDragged = (typeof mouseDragged === "function") ? mouseDragged : window.mouseDragged;\\n' +
    'window.mousePressed = (typeof mousePressed === "function") ? mousePressed : window.mousePressed;\\n' +
    'window.mouseReleased = (typeof mouseReleased === "function") ? mouseReleased : window.mouseReleased;\\n' +
    'window.mouseClicked = (typeof mouseClicked === "function") ? mouseClicked : window.mouseClicked;\\n' +
    'window.doubleClicked = (typeof doubleClicked === "function") ? doubleClicked : window.doubleClicked;\\n' +
    'window.mouseWheel = (typeof mouseWheel === "function") ? mouseWheel : window.mouseWheel;\\n' +
    'window.touchStarted = (typeof touchStarted === "function") ? touchStarted : window.touchStarted;\\n' +
    'window.touchMoved = (typeof touchMoved === "function") ? touchMoved : window.touchMoved;\\n' +
    'window.touchEnded = (typeof touchEnded === "function") ? touchEnded : window.touchEnded;\\n' +
    'window.keyPressed = (typeof keyPressed === "function") ? keyPressed : window.keyPressed;\\n' +
    'window.keyReleased = (typeof keyReleased === "function") ? keyReleased : window.keyReleased;\\n' +
    'window.keyTyped = (typeof keyTyped === "function") ? keyTyped : window.keyTyped;\\n' +
    'window.deviceMoved = (typeof deviceMoved === "function") ? deviceMoved : window.deviceMoved;\\n' +
    'window.deviceTurned = (typeof deviceTurned === "function") ? deviceTurned : window.deviceTurned;\\n' +
    'window.deviceShaken = (typeof deviceShaken === "function") ? deviceShaken : window.deviceShaken;\\n' +
    '})();\\n' +
    '//# sourceURL=' + (window._p5SketchFileName || 'sketch') + '.js\\n';
  try {
    const runner = new Function('window', executableCode);
    runner(window);
  } catch (err) {
    let raw = (err && err.message ? err.message : String(err));
    if (_p5ShouldSuppressError(raw)) { return; }
    let msg = '[‼️RUNTIME ERROR] ' + raw;
    showError(msg);
    if (typeof vscode !== "undefined") {
      vscode.postMessage({ type: "showError", message: msg });
    }
    window._p5Instance = null;
    return;
  }

  try {
  window._p5Instance = new window.p5();
    // --- Stepping compatibility (p5 1.x):
    // When debug stepping, user draw() is instrumented as async and yields between statements.
    // p5 1.x keeps calling redraw() every frame, which calls resetMatrix() and wipes transforms
    // between steps. While a stepped frame is in progress, skip redraw() to preserve state.
    try {
      const inst = window._p5Instance;
      if (inst && typeof inst._draw === 'function' && !inst._p5SteppingDrawLoopPatched) {
        inst._p5SteppingDrawLoopPatched = true;
        const _origDraw = inst._draw;
        inst._draw = function(ts) {
          try {
            const steppingHelpersActive =
              (typeof window.__liveP5WaitStep === 'function')
              || (typeof window.__liveP5StepAdvance === 'function')
              || (typeof window.__liveP5Highlight === 'function')
              || (typeof window.__liveP5ClearHighlight === 'function');
            if (steppingHelpersActive && window.__liveP5FrameInProgress && !window.__liveP5SteppingDone) {
              if (inst._loop) {
                try { inst._requestAnimId = window.requestAnimationFrame(inst._draw); } catch {}
              }
              return;
            }
          } catch {}
          try { return _origDraw.call(inst, ts); }
          catch (e) { try { return _origDraw(ts); } catch { throw e; } }
        };
      }
    } catch {}
    try { applyDrawLoopState(); } catch {}
    // After p5 starts, poll for setup completion once and push all current globals to Variables panel
    try {
      if (window._p5SetupWatcher) { try { clearInterval(window._p5SetupWatcher); } catch {} }
      window._p5SetupWatcher = setInterval(() => {
        try {
          if (window._p5SetupDone && !window._p5PostedAfterSetup) {
            window._p5PostedAfterSetup = true;
            try { window.__p5LoopGuardActive = false; window.__p5LoopGuardMsg = ''; } catch {}
            if (window._p5GlobalVarTypes) {
              Object.keys(window._p5GlobalVarTypes).forEach(name => {
                try {
                  let val = window[name];
                  // Normalize by declared type
                  const t = window._p5GlobalVarTypes[name] || typeof val;
                  if (t === 'number') {
                    const n = Number(val);
                    if (!Number.isNaN(n)) val = n;
                  } else if (t === 'boolean') {
                    val = (val === true || val === 'true' || val === 1 || val === '1');
                  } else if (t !== 'string') {
                    // Skip complex types for the Variables panel
                    return;
                  }
                  const generatedAt = Date.now();
                  try {
                    if (!window._p5VarUpdateTimes) window._p5VarUpdateTimes = {};
                    window._p5VarUpdateTimes[name] = generatedAt;
                  } catch {}
                  try { vscode.postMessage({ type: 'updateGlobalVar', name, value: cloneValueForPost(val), generatedAt }); } catch {}
                } catch {}
              });
            }
            try { if (window._p5SetupWatcher) { clearInterval(window._p5SetupWatcher); window._p5SetupWatcher = null; } } catch {}
          }
        } catch {}
      }, 50);
    } catch {}
  } catch (err) {
    let raw = (err && err.message ? err.message : String(err));
    if (_p5ShouldSuppressError(raw)) { return; }
    let msg = '[‼️RUNTIME ERROR] ' + raw;
    showError(msg);
    if (typeof vscode !== "undefined") {
      vscode.postMessage({ type: "showError", message: msg });
    }
    window._p5Instance = null;
  }
}

function waitForP5AndRunSketch() {
  // If there's no user code (e.g., a syntax error path injected empty code),
  // don't instantiate p5 to prevent runtime errors like _decrementPreload.
  const hasCode = typeof window._p5UserCode === 'string' && window._p5UserCode.trim().length > 0;
  if (!hasCode) {
    return; // Extension will display the syntax error overlay separately.
  }
  // Defer running until p5 is loaded AND variables have been sent so watchers are installed,
  // to ensure we capture final values after setup-only sketches.
  window._p5WaitStart = window._p5WaitStart || performance.now();
  const MAX_WAIT_MS = 1200; // safety cap
  const watchersReady = !!window._p5VarWatchersReady; // set when 'setGlobalVars' arrives
  if (window.p5 && (watchersReady || (performance.now() - window._p5WaitStart) > MAX_WAIT_MS)) {
    runUserSketch(window._p5UserCode);
  } else {
    setTimeout(waitForP5AndRunSketch, 10);
  }
}
waitForP5AndRunSketch();

// Toolbar buttons removed; actions triggered via VS Code title bar commands.

if (typeof window._p5FpsIndicatorRaf !== 'number') {
  window._p5FpsIndicatorRaf = 0;
}
window._p5LastFpsIndicatorUpdateAt = 0;
function updateFpsIndicator(force) {
  try {
    const el = document.getElementById('fps-indicator');
    if (!el) return;
    const isVisible = !(el.style && el.style.display === 'none');
    if (!isVisible) return;
    const now = (typeof performance !== 'undefined' && performance && typeof performance.now === 'function')
      ? performance.now()
      : Date.now();
    if (!force && window._p5LastFpsIndicatorUpdateAt && (now - window._p5LastFpsIndicatorUpdateAt) < 250) {
      return;
    }
    window._p5LastFpsIndicatorUpdateAt = now;
    let fpsValue = Number.NaN;
    const inst = window._p5Instance;
    if (inst) {
      if (typeof inst.frameRate === 'function') {
        fpsValue = Number(inst.frameRate());
      } else if (typeof inst._frameRate === 'number') {
        fpsValue = Number(inst._frameRate);
      }
    }
    el.textContent = Number.isFinite(fpsValue) && fpsValue >= 0
      ? ('FPS: ' + fpsValue.toFixed(1))
      : 'FPS: --';
  } catch {}
}
function tickFpsIndicator() {
  try { updateFpsIndicator(false); } catch {}
  try { window._p5FpsIndicatorRaf = requestAnimationFrame(tickFpsIndicator); } catch {}
}
try {
  if (window._p5FpsIndicatorRaf) {
    cancelAnimationFrame(window._p5FpsIndicatorRaf);
  }
} catch {}
try { window._p5FpsIndicatorRaf = requestAnimationFrame(tickFpsIndicator); } catch {}

window.addEventListener("resize",()=>{ 
  if(window._p5Instance?._renderer && window._p5UserAutoFill){
    window._p5Instance.resizeCanvas(window.innerWidth,window.innerHeight);
    const hasValidBgArgs = Array.isArray(window._p5LastBackgroundArgs) && window._p5LastBackgroundArgs.length > 0;
    const bgArgs = hasValidBgArgs ? window._p5LastBackgroundArgs : [255];
    if(window._p5UserBackground) window._p5Instance.background(...bgArgs);
  }
});

if (typeof window._p5LoopPaused !== 'boolean') {
  window._p5LoopPaused = false;
}
window._p5PendingLoopPaused = undefined;
window._p5FastContinueEnabled = false;
window._p5FastContinuePumping = false;
window._p5FastContinueTimer = null;
window.__liveP5ContinueMode = false;
window.__liveP5ContinuePauseHere = false;
window.__liveP5ContinueBreakpoints = {};
window.__liveP5ContinueBreakpointSteps = {};
window.__liveP5ContinueHasStepTargets = false;
window.__liveP5ContinueSkipStepId = 0;
window.__liveP5ContinueSkipDone = true;
window.__liveP5StepIntoTargetStepId = 0;
window.__liveP5StepIntoActive = false;
function applyDrawLoopState(){
  try {
    if (!window._p5Instance) return;
    if (window._p5LoopPaused) {
      if (typeof window._p5Instance.noLoop === 'function') { window._p5Instance.noLoop(); }
    } else {
      if (typeof window._p5Instance.loop === 'function') { window._p5Instance.loop(); }
    }
  } catch {}
}

function pumpFastContinue(){
  if (window._p5FastContinuePumping) return;
  window._p5FastContinuePumping = true;
  const tick = () => {
    try {
      if (!window._p5FastContinueEnabled) {
        if (window._p5FastContinueTimer) {
          try { clearTimeout(window._p5FastContinueTimer); } catch {}
          window._p5FastContinueTimer = null;
        }
        window._p5FastContinuePumping = false;
        return;
      }
      // Advance in batches, then yield so stop/toggle messages stay responsive.
      let budget = 256;
      while (
        budget > 0
        && window._p5FastContinueEnabled
        && !window.__liveP5ContinuePauseHere
        && typeof window.__liveP5StepAdvance === 'function'
        && window.__liveP5StepResolve
      ) {
        window.__liveP5StepAdvance();
        budget--;
      }
    } catch {}
    try { window._p5FastContinueTimer = setTimeout(tick, 0); } catch { window._p5FastContinuePumping = false; }
  };
  try { window._p5FastContinueTimer = setTimeout(tick, 0); } catch { window._p5FastContinuePumping = false; }
}

function setFastContinueEnabled(enabled, breakpointLines, breakpointStepIds, skipStepId){
  if (Array.isArray(breakpointLines)) {
    const next = {};
    for (let i = 0; i < breakpointLines.length; i++) {
      const n = Number(breakpointLines[i]);
      if (Number.isFinite(n) && n >= 1) {
        next[Math.trunc(n)] = true;
      }
    }
    window.__liveP5ContinueBreakpoints = next;
  }
  if (Array.isArray(breakpointStepIds)) {
    const nextSteps = {};
    for (let i = 0; i < breakpointStepIds.length; i++) {
      const n = Number(breakpointStepIds[i]);
      if (Number.isFinite(n) && n >= 1) {
        nextSteps[Math.trunc(n)] = true;
      }
    }
    window.__liveP5ContinueBreakpointSteps = nextSteps;
    window.__liveP5ContinueHasStepTargets = Object.keys(nextSteps).length > 0;
  } else {
    window.__liveP5ContinueBreakpointSteps = {};
    window.__liveP5ContinueHasStepTargets = false;
  }
  window._p5FastContinueEnabled = !!enabled;
  window.__liveP5ContinueMode = !!enabled;
  if (window._p5FastContinueEnabled) {
    window.__liveP5ContinuePauseHere = false;
    const skipId = Number(skipStepId);
    if (Number.isFinite(skipId) && skipId >= 1) {
      window.__liveP5ContinueSkipStepId = Math.trunc(skipId);
      window.__liveP5ContinueSkipDone = false;
    } else {
      window.__liveP5ContinueSkipStepId = 0;
      window.__liveP5ContinueSkipDone = true;
    }
  }
  if (!window._p5FastContinueEnabled) {
    window.__liveP5ContinuePauseHere = false;
    window.__liveP5ContinueBreakpointSteps = {};
    window.__liveP5ContinueHasStepTargets = false;
    window.__liveP5ContinueSkipStepId = 0;
    window.__liveP5ContinueSkipDone = true;
    if (window._p5FastContinueTimer) {
      try { clearTimeout(window._p5FastContinueTimer); } catch {}
      window._p5FastContinueTimer = null;
    }
    window._p5FastContinuePumping = false;
  }
  if (window._p5FastContinueEnabled) {
    pumpFastContinue();
  }
}

window.addEventListener("message", e => {
  const data = e.data;
  switch(data.type){
    case "invokeTrigger": {
      const fnName = String((data && (data.fnName || data.name)) || '');
      const rawArgs = Array.isArray(data && data.args) ? data.args : [];
      if (!fnName) break;
      try {
        const fn = window[fnName];
        if (typeof fn !== 'function') {
          try { vscode.postMessage({ type: 'showError', message: '[TRIGGER] Function not found: ' + fnName }); } catch {}
          break;
        }
        const coerceArg = (v) => {
          if (typeof v !== 'string') return v;
          const s = v.trim();
          if (s === '') return v;
          if (s === 'true') return true;
          if (s === 'false') return false;
          if (s === 'null') return null;
          // numeric-looking (also supports comma decimal and scientific notation)
          let numCandidate = s;
          const commaCount = (numCandidate.match(/,/g) || []).length;
          const hasDot = numCandidate.indexOf('.') !== -1;
          if (commaCount === 1 && !hasDot) {
            numCandidate = numCandidate.replace(',', '.');
          }
          if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(numCandidate)) {
            const n = Number(numCandidate);
            if (Number.isFinite(n)) return n;
          }
          return v;
        };
        const args = rawArgs.map(coerceArg);
        fn.apply(window, args);
      } catch (err) {
        const raw = (err && err.message) ? String(err.message) : String(err);
        try { vscode.postMessage({ type: 'showError', message: '[TRIGGER] ' + raw }); } catch {}
      }
      break;
    }
    case "invokeReload": {
      const preserveGlobals = (data && typeof data.preserveGlobals === 'boolean') ? !!data.preserveGlobals : true;
      vscode.postMessage({type:"reload-button-clicked", preserveGlobals});
      break;
    }
    case "invokeStepRun":
      vscode.postMessage({type:"step-run-clicked"});
      break;
    case "invokeContinue":
      vscode.postMessage({type:"continue-clicked"});
      break;
    case "invokeSingleStep":
      vscode.postMessage({type:"single-step-clicked"});
      break;
    case "invokeStepInto":
      vscode.postMessage({type:"step-into-clicked"});
      break;
    case "pauseDrawLoop":
      window._p5LoopPaused = true;
      applyDrawLoopState();
      break;
    case "resumeDrawLoop":
      window._p5LoopPaused = false;
      applyDrawLoopState();
      break;
    case "toggleCaptureVisibility":
      window._p5CaptureVisible = !window._p5CaptureVisible;
      if (typeof window._applyCaptureVisibility === 'function') {
        try { window._applyCaptureVisibility(); } catch {}
      }
      try { vscode.postMessage({ type: 'captureVisibilityChanged', visible: !!window._p5CaptureVisible }); } catch {}
      break;
    case "reload":
      setFastContinueEnabled(false);
      // Always reset capture UI/timer on reload so the panel timer shows fresh
      try { if (typeof window._resetCaptureUIAndTimer === 'function') window._resetCaptureUIAndTimer(); } catch {}
      // Clear stepping state so the draw loop cannot remain frozen after stopping debugging.
      try {
        window.__liveP5Gate = null;
        window.__liveP5DrawBusy = false;
        window.__liveP5FrameCounter = 0;
        window.__liveP5StepResolve = null;
        window.__liveP5StepAdvance = null;
        window.__liveP5StepIntoTargetStepId = 0;
        window.__liveP5StepIntoActive = false;
        window.__liveP5WaitStep = null;
        window.__liveP5Highlight = null;
        window.__liveP5ClearHighlight = null;
        window.__liveP5FrameInProgress = false;
        window.__liveP5ShouldWaitForFrame = false;
        window.__liveP5SteppingDone = true;
        window.__liveP5Stepping = false;
        window.__liveP5SetupDone = true;
      } catch {}
      const nextLoopPaused = (typeof data.loopPaused === 'boolean') ? !!data.loopPaused : false;
      window._p5PendingLoopPaused = nextLoopPaused;
      window._p5LoopPaused = nextLoopPaused;
      try { applyDrawLoopState(); } catch {}
      if (data.preserveGlobals) {
        // Reset stepping control flags before reloading
        try {
          window.__liveP5Gate = null;
          window.__liveP5DrawBusy = false;
          window.__liveP5FrameCounter = 0;
          window.__liveP5StepResolve = null;
          window.__liveP5StepAdvance = null;
          window.__liveP5StepIntoTargetStepId = 0;
          window.__liveP5StepIntoActive = false;
          window.__liveP5Stepping = false;
        } catch {}
        try {
          window.__p5LoopGuardActive = false;
          window.__p5LoopGuardMsg = '';
          if (typeof window.__p5ResetLoopGuards === 'function') window.__p5ResetLoopGuards();
        } catch {}
        // Save current global values
  const prevGlobals = {};
        if (window._p5GlobalVarTypes) {
          Object.keys(window._p5GlobalVarTypes).forEach(name => {
            prevGlobals[name] = window[name];
          });
        }
        // Remove global var declarations and window assignments from code
  let codeNoGlobals = String(data.code);
        if (window._p5GlobalVarTypes) {
          Object.keys(window._p5GlobalVarTypes).forEach(name => {
            // Remove lines like 'var x = ...;' or 'var x;' (with or without semicolon)
            codeNoGlobals = codeNoGlobals.replace(new RegExp('^\\s*var\\s+'+name+'(\\s*=.*)?;?\\s*$', 'gm'), '');
            // Remove lines like 'window.x = x;' (with or without semicolon)
            codeNoGlobals = codeNoGlobals.replace(new RegExp('^\\s*window\\\.'+name+'\\s*=\\s*' + name + ';?\\s*$', 'gm'), '');
          });
        }
        runUserSketch(codeNoGlobals);
        // Restore global values
        if (window._p5GlobalVarTypes) {
          Object.keys(prevGlobals).forEach(name => {
            window[name] = prevGlobals[name];
          });
        }
      } else {
        // Reset stepping control flags before reloading
        try {
          window.__liveP5Gate = null;
          window.__liveP5DrawBusy = false;
          window.__liveP5FrameCounter = 0;
          window.__liveP5StepResolve = null;
          window.__liveP5StepAdvance = null;
          window.__liveP5StepIntoTargetStepId = 0;
          window.__liveP5StepIntoActive = false;
          window.__liveP5Stepping = false;
        } catch {}
        try {
          window.__p5LoopGuardActive = false;
          window.__p5LoopGuardMsg = '';
          if (typeof window.__p5ResetLoopGuards === 'function') window.__p5ResetLoopGuards();
        } catch {}
  runUserSketch(String(data.code));
      }
      break;
    case "stop":
      setFastContinueEnabled(false);
      try {
        window.__liveP5Gate = null;
        window.__liveP5DrawBusy = false;
        window.__liveP5FrameCounter = 0;
        window.__liveP5StepResolve = null;
        window.__liveP5StepAdvance = null;
        window.__liveP5StepIntoTargetStepId = 0;
        window.__liveP5StepIntoActive = false;
        window.__liveP5Stepping = false;
      } catch {}
      try {
        window.__p5LoopGuardActive = false;
        window.__p5LoopGuardMsg = '';
        if (typeof window.__p5ResetLoopGuards === 'function') window.__p5ResetLoopGuards();
      } catch {}
      try { if (typeof window._resetCaptureUIAndTimer === 'function') window._resetCaptureUIAndTimer(); } catch {}
      safeRemoveP5Instance();
      document.querySelectorAll("canvas").forEach(c=>c.remove());
      break;
    case "showError": showError(data.message); break;
    case "showWarning": showWarning(data.message); break;
  case "resetErrorFlag": window._p5ErrorLogged = false; break;
    case "syntaxError": showError(data.message); break;
    case "requestLastRuntimeError":
      // If there was a runtime error, re-send it to the extension
      if (window._p5ErrorLogged && window._p5Instance == null) {
        const el = document.getElementById("error-overlay");
        if (el && el.textContent) {
          // --- FIX: Always prefix with [RUNTIME ERROR] if not present ---
          let msg = el.textContent || '';
          if (typeof msg !== 'string') { try { msg = String(msg); } catch { msg = '' + msg; } }
          if (!msg.startsWith("[‼️RUNTIME ERROR]")) {
            msg = "[‼️RUNTIME ERROR] " + msg;
          }
          vscode.postMessage({type:"showError",message:msg});
        }
      }
      break;
    case 'step-advance':
      try {
        if (typeof window.__liveP5StepAdvance === 'function') {
          // If there is an active step resolver, advance; otherwise clear highlight once.
          if (window.__liveP5StepResolve) {
            window.__liveP5StepAdvance();
          } else if (typeof window.__liveP5ClearHighlight === 'function') {
            window.__liveP5ClearHighlight();
          }
        } else if (typeof window.__liveP5ClearHighlight === 'function') {
          window.__liveP5ClearHighlight();
        }
      } catch (e) { }
      break;
    case 'set-step-into-target':
      try {
        const n = Number(data.stepId);
        window.__liveP5StepIntoTargetStepId = (Number.isFinite(n) && n >= 1) ? Math.trunc(n) : 0;
      } catch {}
      break;
    case 'set-fast-continue':
      try { setFastContinueEnabled(!!data.enabled, data.breakpointLines, data.breakpointStepIds, data.skipStepId); } catch {}
      break;
    case 'setGlobalVars':
      if (typeof data.debounceDelay === 'number') {
        window._p5DebounceDelay = data.debounceDelay;
      }
      const readOnly = !!data.readOnly;
      const suppressPanel = !!data.suppressPanel;
      // Store types and update timestamps for later use before rendering
      window._p5GlobalVarTypes = {};
      window._p5GlobalVarReadonly = {};
      if (!window._p5VarUpdateTimes) window._p5VarUpdateTimes = {};
      (data.variables || []).forEach((v) => {
        if (!v || !v.name) return;
        const incomingType = v.type || (Array.isArray(v.value) ? 'array' : typeof v.value);
        window._p5GlobalVarTypes[v.name] = incomingType;
        window._p5GlobalVarReadonly[v.name] = !!v.readonly;
        if (typeof v.updatedAt === 'number') {
          window._p5VarUpdateTimes[v.name] = v.updatedAt;
        }
      });
      renderGlobalVarControls(data.variables, readOnly, { suppressPanel });
      // Install watchers so changes from the sketch propagate live to the Variables panel
  try { if (typeof window._installGlobalVarWatchers === 'function') window._installGlobalVarWatchers(data.variables); } catch {}
      // Start rAF-based polling to ensure live updates even when accessors cannot be defined
  try { if (typeof window._startGlobalVarPolling === 'function') window._startGlobalVarPolling(data.variables); } catch {}
      // Signal that watchers are ready so we can start the sketch safely
  try { window._p5VarWatchersReady = true; } catch {}
      break;
    case 'updateGlobalVar':
      updateGlobalVarInSketch(data.name, data.value);
      break;
    case 'requestGlobalsSnapshot':
      try {
        // If we've already posted final values after setup, skip duplicate snapshot
        if (window._p5PostedAfterSetup) break;
        if (window._p5GlobalVarTypes) {
          Object.keys(window._p5GlobalVarTypes).forEach(name => {
            try {
              let val = window[name];
              const t = (window._p5GlobalVarTypes && window._p5GlobalVarTypes[name]) || typeof val;
              if (t === 'number') {
                const n = Number(val);
                if (!Number.isNaN(n)) val = n;
              } else if (t === 'boolean') {
                val = (val === true || val === 'true' || val === 1 || val === '1');
              } else if (t === 'array' || Array.isArray(val)) {
                val = cloneValueForPost(val);
              } else if (t !== 'string') {
                return;
              }
              const generatedAt = Date.now();
              try {
                if (!window._p5VarUpdateTimes) window._p5VarUpdateTimes = {};
                window._p5VarUpdateTimes[name] = generatedAt;
              } catch {}
              try { vscode.postMessage({ type: 'updateGlobalVar', name, value: cloneValueForPost(val), generatedAt }); } catch {}
            } catch {}
          });
        }
      } catch {}
      break;
    case "toggleRecordButton": {
      // Now only sets internal capture visibility flag (no button UI)
      window._p5CaptureVisible = !!data.show;
      if (typeof window._applyCaptureVisibility === 'function') {
        try { window._applyCaptureVisibility(); } catch {}
      }
      break;
    }
    case 'updateVarDebounceDelay':
  if (typeof data.value === 'number') window._p5VarControlDebounceDelay = data.value;
      break;
    case 'updateOverlayFontSize':
      if (typeof data.value === 'number') {
        document.documentElement.style.setProperty('--overlay-font-size', data.value + 'px');
      }
      break;
    case 'toggleFPS':
      try {
        const el = document.getElementById('fps-indicator');
        if (el) {
          el.style.display = data.show ? 'block' : 'none';
          if (data.show) {
            updateFpsIndicator(true);
          } else {
            el.textContent = '';
          }
        }
      } catch {}
      break;
    case 'showTopInputs':
      try {
        if (!data || !Array.isArray(data.items)) return;
        const overlay = document.getElementById('inputs-overlay');
        const container = document.getElementById('inputs-container');
        const btnSubmit = document.getElementById('inputs-submit');
        if (!overlay || !container) return;
        container.innerHTML = '';
  data.items.forEach((it) => {
          const row = document.createElement('div');
          row.className = 'input-row';
          const lab = document.createElement('label');
          lab.textContent = ((it && it.label) || (it && it.varName)) + ':';
          lab.htmlFor = 'topin_' + it.varName;
          let inputEl;
          if (typeof it.defaultValue === 'boolean') {
            inputEl = document.createElement('input');
            inputEl.type = 'checkbox';
            inputEl.id = 'topin_' + it.varName;
            inputEl.checked = !!it.defaultValue;
          } else {
            inputEl = document.createElement('input');
            inputEl.type = (typeof it.defaultValue === 'number') ? 'number' : 'text';
            inputEl.id = 'topin_' + it.varName;
            if (typeof it.defaultValue !== 'undefined' && it.defaultValue !== null) {
              inputEl.value = String(it.defaultValue);
            } else {
              inputEl.value = '';
            }
          }
          inputEl.setAttribute('data-name', it.varName);
          row.appendChild(lab);
          row.appendChild(inputEl);
          container.appendChild(row);
        });
        // Validation: enable Run only when all non-checkbox fields are filled (non-empty and valid number for numeric fields)
        function allValid() {
          let ok = true;
          container.querySelectorAll('[data-name]').forEach((el) => {
            if (!ok) return;
            if (el.type === 'checkbox') { ok = true; return; }
            const v = ((el.value || '').trim());
            if (v.length === 0) { ok = false; return; }
            if (el.type === 'number') {
              const n = Number(v);
              if (Number.isNaN(n)) { ok = false; return; }
            }
          });
          return ok;
        }
        function wireValidation() {
          if (!btnSubmit) return;
          const update = () => { btnSubmit.disabled = !allValid(); };
          container.querySelectorAll('[data-name]').forEach((el) => {
            el.addEventListener('input', update);
            el.addEventListener('change', update);
          });
          // initial state
          update();
        }
        wireValidation();
        if (btnSubmit) {
          btnSubmit.onclick = () => {
            if (btnSubmit.disabled) return;
            const values = [];
            container.querySelectorAll('[data-name]').forEach((el) => {
              const name = el.getAttribute('data-name');
              let value;
              if (el.type === 'checkbox') value = !!el.checked;
              else value = el.value;
              values.push({ name, value });
            });
            vscode.postMessage({ type: 'submitTopInputs', values });
          };
        }
        overlay.style.display = 'block';
        overlay.setAttribute('aria-hidden', 'false');
      } catch {}
      break;
    case 'hideTopInputs': {
  const overlay = document.getElementById('inputs-overlay');
  if (overlay) { overlay.style.display = 'none'; overlay.setAttribute('aria-hidden', 'true'); }
      break;
    }
  }
});

function updateGlobalVarInSketch(name, value) {
  // Always set window[name]; rewritten code references window.<name>
  function isReadOnlyGlobal(targetName) {
    try {
      if (window._p5GlobalVarReadonly && window._p5GlobalVarReadonly[targetName] === true) {
        return true;
      }
      const d = Object.getOwnPropertyDescriptor(window, targetName);
      if (!d) return false;
      // Accessor-backed mutable globals are allowed; only detect explicit const-like setters.
      if (typeof d.get === 'function' && typeof d.set === 'function') {
        try {
          const setterSource = String(d.set || '');
          if (setterSource.indexOf('Assignment to constant variable.') !== -1) return true;
        } catch {}
      }
      if ('writable' in d && d.writable === false) return true;
      return false;
    } catch {
      return false;
    }
  }

  if (isReadOnlyGlobal(name)) {
    return;
  }

  const safeAssign = (nextValue) => {
    try {
      window[name] = nextValue;
      return true;
    } catch {
      return false;
    }
  };

  let type = ((window._p5GlobalVarTypes && window._p5GlobalVarTypes[name]) || typeof window[name]);
  if (type === 'number') {
    const num = Number(value);
    if (!isNaN(num)) {
  if (!safeAssign(num)) return;
  try { if (window._p5VarPollLast) window._p5VarPollLast[name] = num; } catch {}
  try {
    if (!window._p5VarUpdateTimes) window._p5VarUpdateTimes = {};
    window._p5VarUpdateTimes[name] = Date.now();
  } catch {}
    }
  } else if (type === 'boolean') {
    const b = (value === 'true' || value === true);
  if (!safeAssign(b)) return;
  try { if (window._p5VarPollLast) window._p5VarPollLast[name] = b; } catch {}
  try {
    if (!window._p5VarUpdateTimes) window._p5VarUpdateTimes = {};
    window._p5VarUpdateTimes[name] = Date.now();
  } catch {}
  } else if (type === 'array' || Array.isArray(value)) {
  if (!safeAssign(value)) return;
    try {
      if (window._p5VarPollLast) {
        let serialized = null;
        try { serialized = JSON.stringify(value); }
        catch { serialized = null; }
        window._p5VarPollLast[name] = serialized;
      }
    } catch {}
    try {
      if (!window._p5VarUpdateTimes) window._p5VarUpdateTimes = {};
      window._p5VarUpdateTimes[name] = Date.now();
    } catch {}
  } else {
  if (!safeAssign(value)) return;
  try { if (window._p5VarPollLast) window._p5VarPollLast[name] = value; } catch {}
  try {
    if (!window._p5VarUpdateTimes) window._p5VarUpdateTimes = {};
    window._p5VarUpdateTimes[name] = Date.now();
  } catch {}
  }
}

// Live watchers for global variables so the Variables panel updates when the sketch changes values
(function setupVarWatchers(){
  // Backing store for accessor properties
  if (!window._p5GlobalVarValues) window._p5GlobalVarValues = {};
  if (!window._p5VarWatchInstalled) window._p5VarWatchInstalled = {};
  if (!window._p5LastPostedValues) window._p5LastPostedValues = {};
  if (!window._p5VarPollNames) window._p5VarPollNames = new Set();
  if (!window._p5VarPollLast) window._p5VarPollLast = {};
  if (!window._p5VarUpdateTimes) window._p5VarUpdateTimes = {};
  window._p5VarPollRaf = window._p5VarPollRaf || null;

  // Debounced emitter for updateGlobalVar
  if (typeof window._p5VarControlDebounceDelay !== 'number') window._p5VarControlDebounceDelay = 50;
  let _debounceTimer = null;
  let _pendingUpdates = new Map(); // name -> latest value
  let _pendingUpdateTimes = new Map(); // name -> timestamp
  function queueUpdate(name, value) {
    try { _pendingUpdates.set(name, cloneValueForPost(value)); } catch {}
    const now = Date.now();
    try {
      _pendingUpdateTimes.set(name, now);
      if (!window._p5VarUpdateTimes) window._p5VarUpdateTimes = {};
      window._p5VarUpdateTimes[name] = now;
    } catch {}
    if (_debounceTimer) return;
  const delay = (typeof window._p5VarControlDebounceDelay === 'number' ? window._p5VarControlDebounceDelay : 50);
    _debounceTimer = setTimeout(() => {
      try {
  _pendingUpdates.forEach((val, key) => {
          const generatedAt = _pendingUpdateTimes.get(key) || Date.now();
          try { vscode.postMessage({ type: 'updateGlobalVar', name: key, value: cloneValueForPost(val), generatedAt }); } catch {}
        });
      } catch {}
      _pendingUpdates.clear();
      _pendingUpdateTimes.clear();
      _debounceTimer = null;
    }, delay);
  }

  function coerceByType(name, value) {
  const t = ((window._p5GlobalVarTypes && window._p5GlobalVarTypes[name]) || typeof value);
    if (t === 'number') {
      const n = Number(value);
      return Number.isNaN(n) ? value : n;
    }
    if (t === 'boolean') {
      return (value === true || value === 'true' || value === 1 || value === '1');
    }
    return value;
  }

  // Install watchers for new variables
  window._installGlobalVarWatchers = function(vars) {
    if (!Array.isArray(vars)) return;
  vars.forEach((v) => {
      const name = v && v.name;
      if (!name) return;
  if (window._p5VarWatchInstalled[name]) return; // avoid redefining
      try {
        // Capture current value as initial backing value
  let curr = (typeof window[name] !== 'undefined') ? window[name] : v.value;
  window._p5GlobalVarValues[name] = coerceByType(name, curr);
  if (!window._p5VarUpdateTimes) window._p5VarUpdateTimes = {};
  if (typeof window._p5VarUpdateTimes[name] !== 'number') {
    window._p5VarUpdateTimes[name] = Date.now();
  }
  const desc = Object.getOwnPropertyDescriptor(window, name);
        // If globals are already bridged via accessor (from code rewrite), preserve that bridge.
        if (desc && typeof desc.get === 'function' && typeof desc.set === 'function') {
          window._p5VarWatchInstalled[name] = true;
          return;
        }
        // Define accessor only if configurable or not defined on window, to avoid errors
        if (!desc || desc.configurable !== false) {
          Object.defineProperty(window, name, {
            configurable: true,
            enumerable: true,
            get() {
              return window._p5GlobalVarValues[name];
            },
            set(val) {
              const newVal = coerceByType(name, val);
              const prev = window._p5GlobalVarValues[name];
              window._p5GlobalVarValues[name] = newVal;
              // Only notify if actually changed (strict equality for primitives)
              if (prev !== newVal) {
                queueUpdate(name, newVal);
                window._p5LastPostedValues[name] = cloneValueForPost(newVal);
              }
            }
          });
          window._p5VarWatchInstalled[name] = true;
        }
      } catch {}
    });
  };

  // rAF-based poller as a fallback when accessors can't be defined on window (e.g., non-configurable globals)
  function tickPoller() {
    try {
      // Only check simple primitives
  window._p5VarPollNames.forEach((name) => {
        try {
          const t = ((window._p5GlobalVarTypes && window._p5GlobalVarTypes[name]) || typeof window[name]);
          let curr = window[name];
          if (t === 'number') {
            const n = Number(curr);
            if (!Number.isNaN(n)) curr = n;
          } else if (t === 'boolean') {
            curr = (curr === true || curr === 'true' || curr === 1 || curr === '1');
          } else if (t === 'array' || Array.isArray(curr)) {
            let serialized = null;
            try { serialized = JSON.stringify(curr); }
            catch { serialized = null; }
            const prevSerialized = window._p5VarPollLast[name];
            if (serialized !== prevSerialized) {
              window._p5VarPollLast[name] = serialized;
              queueUpdate(name, curr);
            }
            return;
          } else if (t !== 'string') {
            // Skip complex types
            return;
          }
          const prev = window._p5VarPollLast[name];
          if (prev !== curr) {
            window._p5VarPollLast[name] = curr;
            queueUpdate(name, curr);
          }
        } catch {}
      });
    } catch {}
  window._p5VarPollRaf = requestAnimationFrame(tickPoller);
  }

  window._startGlobalVarPolling = function(vars) {
    try {
      if (Array.isArray(vars)) {
  vars.forEach((v) => { if (v && v.name) window._p5VarPollNames.add(v.name); });
      }
      // Seed last values to avoid immediate spam
      if (Array.isArray(vars)) {
  vars.forEach((v) => {
          if (v && v.name) {
            const val = window[v.name];
            if (Array.isArray(val)) {
              try { window._p5VarPollLast[v.name] = JSON.stringify(val); }
              catch { window._p5VarPollLast[v.name] = null; }
            } else {
              window._p5VarPollLast[v.name] = val;
            }
          }
        });
      }
    } catch {}
    if (!window._p5VarPollRaf) {
      window._p5VarPollRaf = requestAnimationFrame(tickPoller);
    }
  };
})();

// Hides the variable drawer UI in the webview
function hideDrawer() {
  const controls = document.getElementById('p5-var-controls');
  const tab = document.getElementById('p5-var-drawer-tab');
  if (!controls || !tab) return;
  // Ensure controls stay in DOM (so height animation works) but slide out
  controls.classList.add('drawer-hidden');
  controls.style.display = 'flex';
  tab.style.display = 'flex';
  tab.classList.add('tab-visible');
}

// Shows the variable drawer UI in the webview
function showDrawer() {
  const controls = document.getElementById('p5-var-controls');
  const tab = document.getElementById('p5-var-drawer-tab');
  if (!controls || !tab) return;
  controls.style.display = 'flex';
  controls.classList.remove('drawer-hidden');
  tab.classList.remove('tab-visible');
  // Give animation a frame to apply; then hide tab fully
  setTimeout(() => { tab.style.display = 'none'; }, 200);
}

function cloneValueForPost(value) {
  if (Array.isArray(value)) {
    try { return JSON.parse(JSON.stringify(value)); }
    catch {
      try { return value.map((item) => cloneValueForPost(item)); }
      catch {
        try { return Array.from(value); }
        catch { return value; }
      }
    }
  }
  return value;
}

// Dynamically creates/removes the variable drawer and tab, and sets up event listeners for variable changes
function renderGlobalVarControls(vars, readOnly, opts) {
  const suppressPanel = !!(opts && opts.suppressPanel);
  // Send globals to the extension for the Variables panel,
  // but enrich values with current runtime values if available so we don't revert to initial code values.
  if (!suppressPanel && typeof vscode !== 'undefined' && Array.isArray(vars)) {
    try {
      const snapshotTime = Date.now();
      const list = vars.map((v) => {
        const name = v && v.name;
        if (!name) return v;
  let t = ((window._p5GlobalVarTypes && window._p5GlobalVarTypes[name]) || v.type || typeof window[name]);
  let val = (typeof window[name] !== 'undefined') ? window[name] : v.value;
        if (Array.isArray(val)) {
          t = 'array';
        }
        if (t === 'number') {
          const n = Number(val);
          if (!Number.isNaN(n)) val = n;
        } else if (t === 'boolean') {
          val = (val === true || val === 'true' || val === 1 || val === '1');
        } else if (t !== 'string') {
          // keep original for complex types
        }
        const safeVal = cloneValueForPost(val);
        const type = Array.isArray(val) ? 'array' : t;
        if (!window._p5VarUpdateTimes) window._p5VarUpdateTimes = {};
        const lastUpdate = (window._p5VarUpdateTimes && typeof window._p5VarUpdateTimes[name] === 'number')
          ? window._p5VarUpdateTimes[name]
          : snapshotTime;
        window._p5VarUpdateTimes[name] = lastUpdate;
        return { ...v, value: safeVal, type, updatedAt: lastUpdate };
      });
  vscode.postMessage({ type: 'setGlobalVars', variables: list, generatedAt: snapshotTime });
    } catch {}
  }
  // Remove/hide any existing drawer UI if present
  const controls = document.getElementById('p5-var-controls');
  const tab = document.getElementById('p5-var-drawer-tab');
  if (controls) controls.remove();
  if (tab) tab.remove();
  // Do not create or show the drawer anymore
}

// Function to sync drawer inputs with global variable values
function syncDrawerWithGlobals() {
  if (!window._p5GlobalVarTypes) return;
  const controls = document.getElementById('p5-var-controls');
  if (!controls) return;
  Object.keys(window._p5GlobalVarTypes).forEach(name => {
  const type = window._p5GlobalVarTypes[name];
    const input = controls.querySelector('input[data-var="' + name + '"]');
    if (!input) return;
    let globalVal = window[name];
    if (type === 'number') {
      // --- PATCH: match input formatting to initial value ---
      if (input !== document.activeElement) {
        let step = input.step;
        if (step === '1') {
          // Integer: always show floored value
          if (input.value !== String(Math.floor(globalVal))) input.value = Math.floor(globalVal);
        } else if (step && step !== 'any') {
          // Decimal: use precision from step
          let precision = 0;
          if (step.indexOf('.') !== -1) precision = step.split('.')[1].length;
          if (typeof globalVal === 'number' && !isNaN(globalVal)) {
            let valStr = Number(globalVal).toFixed(precision);
            if (input.value !== valStr) input.value = valStr;
          }
        } else {
          // Fallback
          if (input.value !== String(globalVal)) input.value = globalVal;
        }
      }
      // --- END PATCH ---
    } else if (type === 'boolean') {
      if (input.checked !== !!globalVal) input.checked = !!globalVal;
    } else {
      if (input !== document.activeElement) {
        if (input.value !== String(globalVal)) input.value = globalVal;
      }
    }
  });
}
</script>
</body>
</html>`;
}
