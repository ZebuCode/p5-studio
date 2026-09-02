import type { GlobalVar, TopInputItem } from '../types';

// Messages sent FROM the webview TO the extension host
export type WebviewToExtensionMessage =
    | { type: 'setGlobalVars'; variables: GlobalVar[]; generatedAt?: number }
    | { type: 'updateGlobalVar'; name: string; value: any; generatedAt?: number }
    | { type: 'focus-script-tab' }
    | { type: 'captureVisibilityChanged'; visible: boolean }
    | { type: 'log'; message: any; focus?: boolean }
    | { type: 'showError'; message: string }
    | { type: 'loopGuardHit'; message?: string }
    | { type: 'openLoopGuardSettings' }
    | { type: 'submitTopInputs'; values: any[] }
    | { type: 'reload-button-clicked'; preserveGlobals?: boolean }
    | { type: 'context-menu-refresh' }
    | { type: 'context-menu-toggle-pause'; pause: boolean }
    | { type: 'context-menu-toggle-capture' }
    | { type: 'context-menu-toggle-fps'; show: boolean }
    | { type: 'step-run-clicked' }
    | { type: 'continue-clicked' }
    | { type: 'single-step-clicked' }
    | { type: 'highlightLine'; line: number }
    | { type: 'gotoErrorLine'; line: number; col?: number }
    | { type: 'clearHighlight'; final?: boolean }
    | { type: 'revealGlobals'; count?: number }
    | { type: 'oscSend'; address: string; args?: any[] }
    | {
        type: 'startOSC';
        localAddress?: string;
        localPort?: number;
        remoteAddress?: string;
        remotePort?: number;
    }
    | { type: 'stopOSC' }
    | { type: 'saveCanvasImage'; dataUrl: string; fileName?: string }
    | { type: 'copyCanvasImage'; dataUrl?: string }
    | { type: 'showInfo'; message: string };

// Messages sent FROM the extension host TO the webview
export type ExtensionToWebviewMessage =
    | { type: 'reload'; code: string; preserveGlobals?: boolean; loopPaused?: boolean; userLineOffset?: number }
    | { type: 'syntaxError'; message: string }
    | { type: 'showWarning'; message: string }
    | { type: 'showTopInputs'; items: TopInputItem[] }
    | { type: 'toggleFPS'; show: boolean }
    | { type: 'updateVarDebounceDelay'; value: number }
    | { type: 'setGlobalVars'; variables: GlobalVar[]; readOnly?: boolean; suppressPanel?: boolean }
    | { type: 'requestGlobalsSnapshot' }
    | { type: 'step-advance' }
    | { type: 'updateOverlayFontSize'; value: number }
    // Additional control/event messages used by the extension
    | { type: 'oscReceive'; address: string; args?: any[] }
    | { type: 'showError'; message: string }
    | { type: 'invokeTrigger'; fnName: string; args?: any[] }
    | { type: 'invokeStepRun' }
    | { type: 'invokeContinue' }
    | { type: 'invokeSingleStep' }
    | { type: 'invokeReload'; preserveGlobals?: boolean }
    | { type: 'toggleCaptureVisibility' }
    | { type: 'pauseDrawLoop' }
    | { type: 'resumeDrawLoop' };

export type AnyWebviewMessage = WebviewToExtensionMessage | ExtensionToWebviewMessage;
