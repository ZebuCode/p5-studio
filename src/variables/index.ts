import * as vscode from 'vscode';
import { registerVariablesView } from '../views/variablesView';
import type { VarControl } from '../types';

export type VarEntry = { name: string; value: any; type: string; updatedAt?: number; control?: VarControl; readonly?: boolean };
type GlobalDefs = Map<string, { type: string; initialValue?: any; control?: VarControl; readonly?: boolean }>;
type LocalsHeading = 'locals' | 'variables';
export type VarState = {
  globals: VarEntry[];
  locals: VarEntry[];
  globalDefs: GlobalDefs;
  globalsSuppressed: boolean;
  pendingGlobals: VarEntry[];
  localsHeading: LocalsHeading;
  forceRevealNextGlobals: boolean;
  globalTimestamps: Map<string, number>;
  hasDraw: boolean;
  globalHints: Map<string, { control?: VarControl }>;
  forcePanelRebuild: boolean;
};

export type VariablesServiceDeps = {
  getActiveP5Panel: () => vscode.WebviewPanel | undefined;
  getDocUriForPanel: (panel: vscode.WebviewPanel) => vscode.Uri | undefined;
};

export type VariablesServiceApi = {
  getGlobalsForDoc: (docUri: string) => VarEntry[];
  requestPanelRebuildForDoc: (docUri: string) => void;
  setGlobalsForDoc: (docUri: string, list: VarEntry[], opts?: { generatedAt?: number }) => void;
  primeGlobalsForDoc: (docUri: string, list: VarEntry[]) => void;
  hasGlobalDefinition: (docUri: string, name: string) => boolean;
  revealGlobalsForDoc: (docUri: string, count?: number) => void;
  setGlobalValue: (docUri: string, name: string, value: any, opts?: { updatedAt?: number }) => void;
  getLocalsForDoc: (docUri: string) => VarEntry[];
  upsertLocalForDoc: (docUri: string, v: VarEntry) => void;
  clearForDoc: (docUri: string) => void;
  updateVariablesPanel: () => void;
  setLocalsHeadingForDoc: (docUri: string, heading: LocalsHeading) => void;
  getLocalsHeadingForDoc: (docUri: string) => LocalsHeading;
  setHasDrawForDoc: (docUri: string, hasDraw: boolean) => void;
  resetValuesForDoc: (docUri: string) => void;
  setGlobalHintsForDoc: (docUri: string, defs: Array<{ name: string; control?: VarControl }>) => void;
};

const inferType = (value: any): string => {
  if (Array.isArray(value)) return 'array';
  const t = typeof value;
  if (t === 'number' || t === 'boolean' || t === 'string') return t;
  if (t === 'object' && value !== null) return 'object';
  return 'string';
};

const cloneVarValue = (value: any): any => {
  if (Array.isArray(value)) {
    try { return JSON.parse(JSON.stringify(value)); }
    catch {
      try { return value.map((item: any) => cloneVarValue(item)); }
      catch { return value.slice ? value.slice() : Array.from(value); }
    }
  }
  return value;
};

const pickControl = (st: VarState, name: string, fallback?: VarControl): VarControl | undefined => {
  if (st.globalHints.has(name)) {
    return st.globalHints.get(name)?.control;
  }
  if (fallback) return fallback;
  return st.globalDefs.get(name)?.control;
};

export function registerVariablesService(
  context: vscode.ExtensionContext,
  deps: VariablesServiceDeps,
): VariablesServiceApi {
  const latestVarsByDoc = new Map<string, VarState>();
  const ensure = (docUri: string): VarState => {
    if (!latestVarsByDoc.has(docUri)) {
      latestVarsByDoc.set(docUri, {
        globals: [],
        locals: [],
        globalDefs: new Map(),
        globalsSuppressed: false,
        pendingGlobals: [],
        localsHeading: 'locals',
        forceRevealNextGlobals: false,
        globalTimestamps: new Map(),
        hasDraw: false,
        globalHints: new Map(),
        forcePanelRebuild: false,
      });
    }
    return latestVarsByDoc.get(docUri)!;
  };

  const upsertEntry = (list: VarEntry[], entry: VarEntry) => {
    const idx = list.findIndex(v => v.name === entry.name);
    if (idx >= 0) list[idx] = entry;
    else list.push(entry);
  };

  const applyHintsToList = (st: VarState, list: VarEntry[]): VarEntry[] =>
    list.map(entry => ({ ...entry, control: pickControl(st, entry.name, entry.control) }));

  const setGlobalHintsForDocInternal = (docUri: string, defs: Array<{ name: string; control?: VarControl }>) => {
    const st = ensure(docUri);
    st.globalHints = new Map();
    if (Array.isArray(defs)) {
      for (const def of defs) {
        if (!def || typeof def.name !== 'string') continue;
        if (def.control) {
          st.globalHints.set(def.name, { control: def.control });
        }
      }
    }
    st.globals = applyHintsToList(st, st.globals);
    st.pendingGlobals = applyHintsToList(st, st.pendingGlobals);
    st.globalDefs = new Map(Array.from(st.globalDefs.entries()).map(([name, def]) => {
      const hint = st.globalHints.get(name);
      return [name, { ...def, control: hint?.control }];
    }));
  };

  const setGlobalValueInternal = (docUri: string, name: string, value: any, opts?: { updatedAt?: number }) => {
    const st = ensure(docUri);
    if (st.globalsSuppressed && st.forceRevealNextGlobals) {
      st.globalsSuppressed = false;
      st.forceRevealNextGlobals = false;
      if (st.pendingGlobals.length) {
        for (const pending of st.pendingGlobals) {
          const safeVal = cloneVarValue(pending.value);
          const entry: VarEntry = {
            name: pending.name,
            type: pending.type || inferType(safeVal),
            value: safeVal,
            updatedAt: typeof pending.updatedAt === 'number' ? pending.updatedAt : Date.now(),
            readonly: !!pending.readonly,
          };
          upsertEntry(st.globals, entry);
          try { st.globalTimestamps.set(entry.name, entry.updatedAt || Date.now()); } catch { }
        }
        st.pendingGlobals = [];
      }
    }
    const timestamp = (opts && typeof opts.updatedAt === 'number') ? opts.updatedAt : Date.now();
    const hinted = st.globalDefs.get(name)?.type
      || st.globals.find(v => v.name === name)?.type
      || st.pendingGlobals.find(v => v.name === name)?.type
      || inferType(value);
    const safeValue = cloneVarValue(value);
    const control = pickControl(st, name);
    const readonly = !!(
      st.globalDefs.get(name)?.readonly
      || st.globals.find(v => v.name === name)?.readonly
      || st.pendingGlobals.find(v => v.name === name)?.readonly
    );
    const nextEntry: VarEntry = { name, value: safeValue, type: hinted, updatedAt: timestamp, control, readonly };

    const visibleIdx = st.globals.findIndex(v => v.name === name);
    if (visibleIdx >= 0) {
      st.globals[visibleIdx] = nextEntry;
    } else if (st.globalsSuppressed) {
      upsertEntry(st.pendingGlobals, nextEntry);
    } else {
      upsertEntry(st.globals, nextEntry);
    }
    const def = st.globalDefs.get(name) || { type: hinted };
    st.globalDefs.set(name, {
      type: hinted || def.type,
      initialValue: typeof def.initialValue !== 'undefined' ? def.initialValue : cloneVarValue(value),
      control: control ?? def.control,
      readonly,
    });
    try { st.globalTimestamps.set(name, timestamp); } catch { }
  };

  const setLocalValueInternal = (docUri: string, name: string, value: any) => {
    const st = ensure(docUri);
    const idx = st.locals.findIndex(v => v.name === name);
    const type = inferType(value);
    const safeValue = cloneVarValue(value);
    if (idx >= 0) st.locals[idx] = { ...st.locals[idx], value: safeValue, type: st.locals[idx].type || type };
    else st.locals.push({ name, value: safeValue, type });
  };

  const { updateVariablesPanel } = registerVariablesView(context, {
    getActiveP5Panel: () => deps.getActiveP5Panel(),
    getDocUriForPanel: (p) => deps.getDocUriForPanel(p),
    getGlobalsForDoc: (docUri: string) => ensure(docUri).globals,
    getLocalsForDoc: (docUri: string) => ensure(docUri).locals,
    getLocalsHeadingForDoc: (docUri: string) => ensure(docUri).localsHeading,
    getHasDrawForDoc: (docUri: string) => ensure(docUri).hasDraw,
    setGlobalValue: setGlobalValueInternal,
    setLocalValue: setLocalValueInternal,
    consumeForceRebuildForDoc: (docUri: string) => {
      const st = ensure(docUri);
      const v = !!st.forcePanelRebuild;
      st.forcePanelRebuild = false;
      return v;
    },
  });

  return {
    getGlobalsForDoc: (docUri: string) => ensure(docUri).globals,
    requestPanelRebuildForDoc: (docUri: string) => {
      const st = ensure(docUri);
      st.forcePanelRebuild = true;
    },
    setGlobalsForDoc: (docUri: string, list: VarEntry[], opts?: { generatedAt?: number }) => {
      const st = ensure(docUri);
      const next = Array.isArray(list)
        ? list.filter(entry => !!entry && typeof entry.name === 'string').map(entry => ({
          ...entry,
          value: cloneVarValue(entry.value),
          type: entry.type || inferType(entry.value),
          control: entry.control,
        }))
        : [];
      const snapshotTime = (opts && typeof opts.generatedAt === 'number') ? opts.generatedAt : Date.now();
      const normalized = next.map(entry => ({
        ...entry,
        updatedAt: (typeof entry.updatedAt === 'number') ? entry.updatedAt : snapshotTime
      }));
      if (st.forceRevealNextGlobals) {
        st.globalsSuppressed = false;
        st.forceRevealNextGlobals = false;
      }
      st.globalDefs = new Map();
      for (const entry of normalized) {
        if (entry && entry.name) {
          const control = pickControl(st, entry.name, entry.control);
          st.globalDefs.set(entry.name, {
            type: entry.type || inferType(entry.value),
            initialValue: cloneVarValue(entry.value),
            control,
            readonly: !!entry.readonly,
          });
        }
      }
      if (st.globalsSuppressed) {
        const pendingByName = new Map(st.pendingGlobals.map(entry => [entry.name, entry] as const));
        const mergedPending: VarEntry[] = [];
        const seenNames = new Set<string>();
        for (const entry of normalized) {
          seenNames.add(entry.name);
          const existing = pendingByName.get(entry.name);
          const lastUpdate = st.globalTimestamps.get(entry.name) || existing?.updatedAt || 0;
          const incomingTime = typeof entry.updatedAt === 'number' ? entry.updatedAt : snapshotTime;
          if (existing && lastUpdate > incomingTime) {
            mergedPending.push({
              ...existing,
              value: cloneVarValue(existing.value),
              readonly: !!entry.readonly,
            });
          } else {
            const control = pickControl(st, entry.name, entry.control);
            const safeEntry: VarEntry = {
              name: entry.name,
              type: entry.type || inferType(entry.value),
              value: cloneVarValue(entry.value),
              updatedAt: incomingTime,
              control,
              readonly: !!entry.readonly,
            };
            mergedPending.push(safeEntry);
            try { st.globalTimestamps.set(entry.name, incomingTime); } catch { }
          }
        }
        // Remove timestamps for globals that disappeared from snapshot
        st.globalTimestamps.forEach((_value, key) => {
          if (!seenNames.has(key)) {
            st.globalTimestamps.delete(key);
          }
        });
        st.pendingGlobals = mergedPending;
        return;
      }
      const existingByName = new Map(st.globals.map(entry => [entry.name, entry] as const));
      const merged: VarEntry[] = [];
      const seenNames = new Set<string>();
      for (const entry of normalized) {
        seenNames.add(entry.name);
        const existing = existingByName.get(entry.name);
        const lastUpdate = st.globalTimestamps.get(entry.name) || existing?.updatedAt || 0;
        const incomingTime = typeof entry.updatedAt === 'number' ? entry.updatedAt : snapshotTime;
        if (existing && lastUpdate > incomingTime) {
          merged.push({
            ...existing,
            value: cloneVarValue(existing.value),
            readonly: !!entry.readonly,
          });
        } else {
          const control = pickControl(st, entry.name, entry.control);
          merged.push({
            name: entry.name,
            type: entry.type || inferType(entry.value),
            value: cloneVarValue(entry.value),
            updatedAt: incomingTime,
            control,
            readonly: !!entry.readonly,
          });
          try { st.globalTimestamps.set(entry.name, incomingTime); } catch { }
        }
      }
      // Remove timestamps for globals no longer present
      st.globalTimestamps.forEach((_value, key) => {
        if (!seenNames.has(key)) {
          st.globalTimestamps.delete(key);
        }
      });
      st.pendingGlobals = [];
      st.globals = merged;
      st.globalsSuppressed = false;
    },
    primeGlobalsForDoc: (docUri: string, list: VarEntry[]) => {
      const st = ensure(docUri);
      const snapshot = Array.isArray(list)
        ? list.filter(entry => !!entry && typeof entry.name === 'string').map(entry => ({
          ...entry,
          value: cloneVarValue(entry.value),
          type: entry.type || inferType(entry.value),
          updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : Date.now(),
          control: entry.control,
          readonly: !!entry.readonly,
        }))
        : [];
      st.globals = [];
      st.locals = [];
      st.globalDefs = new Map();
      st.globalsSuppressed = true;
      st.pendingGlobals = snapshot;
      st.forceRevealNextGlobals = false;
      st.globalTimestamps = new Map();
      for (const entry of snapshot) {
        if (entry && entry.name) {
          const control = pickControl(st, entry.name, entry.control);
          st.globalDefs.set(entry.name, {
            type: entry.type || inferType(entry.value),
            initialValue: cloneVarValue(entry.value),
            control,
            readonly: !!entry.readonly,
          });
          try { st.globalTimestamps.set(entry.name, entry.updatedAt || Date.now()); } catch { }
        }
      }
    },
    hasGlobalDefinition: (docUri: string, name: string) => ensure(docUri).globalDefs.has(name),
    revealGlobalsForDoc: (docUri: string, count?: number) => {
      const st = ensure(docUri);
      const totalPending = st.pendingGlobals.length;
      if (totalPending === 0) {
        st.globalsSuppressed = false;
        return;
      }
      const toReveal = typeof count === 'number' && count > 0
        ? Math.min(count, totalPending)
        : totalPending;
      const released = st.pendingGlobals.splice(0, toReveal);
      for (const entry of released) {
        const sourceValue = (typeof entry.value === 'undefined')
          ? st.globalDefs.get(entry.name)?.initialValue
          : entry.value;
        const safeValue = cloneVarValue(sourceValue);
        const type = entry.type || st.globalDefs.get(entry.name)?.type || inferType(safeValue);
        const now = Date.now();
        const control = pickControl(st, entry.name, entry.control);
        const hydrated: VarEntry = { name: entry.name, value: safeValue, type, updatedAt: now, control, readonly: !!entry.readonly };
        upsertEntry(st.globals, hydrated);
        try { st.globalTimestamps.set(entry.name, now); } catch { }
      }
      st.globalsSuppressed = st.pendingGlobals.length > 0;
    },
    setGlobalValue: setGlobalValueInternal,
    getLocalsForDoc: (docUri: string) => ensure(docUri).locals,
    upsertLocalForDoc: (docUri: string, v: VarEntry) => {
      const st = ensure(docUri);
      const safeValue = cloneVarValue(v.value);
      const idx = st.locals.findIndex(x => x.name === v.name);
      if (idx >= 0) st.locals[idx] = { ...st.locals[idx], value: safeValue, type: v.type || st.locals[idx].type };
      else st.locals.push({ ...v, value: safeValue });
    },
    clearForDoc: (docUri: string) => { try { latestVarsByDoc.delete(docUri); } catch { } },
    updateVariablesPanel,
    setLocalsHeadingForDoc: (docUri: string, heading: LocalsHeading) => {
      const st = ensure(docUri);
      st.localsHeading = heading === 'variables' ? 'variables' : 'locals';
    },
    setHasDrawForDoc: (docUri: string, hasDraw: boolean) => {
      const st = ensure(docUri);
      st.hasDraw = !!hasDraw;
    },
    getLocalsHeadingForDoc: (docUri: string) => ensure(docUri).localsHeading,
    resetValuesForDoc: (docUri: string) => {
      const st = ensure(docUri);
      const now = Date.now();
      const defs = Array.from(st.globalDefs.entries());
      if (defs.length > 0) {
        st.globals = defs.map(([name, def]) => {
          const type = def?.type || inferType(def?.initialValue);
          const value = (typeof def?.initialValue !== 'undefined')
            ? cloneVarValue(def.initialValue)
            : (type === 'number' ? 0 : type === 'boolean' ? false : type === 'array' ? [] : '');
          const control = pickControl(st, name, def?.control);
          return { name, type: type || inferType(value), value, updatedAt: now, control, readonly: !!def?.readonly };
        });
      } else if (st.globals.length > 0) {
        st.globals = st.globals.map(entry => {
          const type = entry.type || inferType(entry.value);
          let value: any;
          if (type === 'number') value = 0;
          else if (type === 'boolean') value = false;
          else if (type === 'array') value = [];
          else value = '';
          const control = pickControl(st, entry.name, entry.control);
          return { name: entry.name, type, value, updatedAt: now, control, readonly: !!entry.readonly };
        });
      } else if (st.pendingGlobals.length > 0) {
        st.globals = st.pendingGlobals.map(entry => ({
          name: entry.name,
          type: entry.type || inferType(entry.value),
          value: cloneVarValue(entry.value),
          updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : now,
          control: pickControl(st, entry.name, entry.control),
          readonly: !!entry.readonly,
        }));
      } else {
        st.globals = [];
      }
      st.locals = [];
      st.pendingGlobals = [];
      st.globalsSuppressed = st.globals.length === 0;
      st.forceRevealNextGlobals = true;
      st.globalTimestamps = new Map(st.globals.map(entry => [entry.name, entry.updatedAt || now] as const));
    },
    setGlobalHintsForDoc: (docUri: string, defs: Array<{ name: string; control?: VarControl }>) => {
      setGlobalHintsForDocInternal(docUri, defs);
      updateVariablesPanel();
    },
  };
}
