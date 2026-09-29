import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { writeFileSync } from 'fs';
import { toLocalISOString } from '../utils/helpers';
import { exec } from 'child_process';
import { config as cfg } from '../config';

// toLocalISOString moved to ../utils/helpers

export function hideFileIfSupported(filePath: string) {
    try {
        if (process.platform === 'win32') {
            exec(`attrib +h "${filePath}"`);
        }
    } catch {
        // ignore
    }
}

export async function refreshJsconfigIfMarkerPresent(context: vscode.ExtensionContext) {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) return;
    try {
        const markerPath = path.join(workspaceFolder.uri.fsPath, '.p5');
        const jsconfigPath = path.join(workspaceFolder.uri.fsPath, 'jsconfig.json');
        const hasMarker = fs.existsSync(markerPath);
        let hasP5ProjectType = false;
        if (fs.existsSync(jsconfigPath)) {
            try {
                const raw = fs.readFileSync(jsconfigPath, 'utf8');
                const parsed = JSON.parse(raw);
                const projectType = typeof parsed?.projectType === 'string' ? parsed.projectType.toLowerCase() : '';
                hasP5ProjectType = projectType === 'p5' || projectType === 'p5js';
            } catch {
                // ignore parse errors and fall back to marker detection
            }
        }
        if (hasMarker || hasP5ProjectType) {
            // Try to hide the marker file on Windows if it's visible
            if (hasMarker) hideFileIfSupported(markerPath);
            // Delete existing jsconfig.json if present
            if (fs.existsSync(jsconfigPath)) {
                try { fs.unlinkSync(jsconfigPath); } catch { /* ignore */ }
            }
            // Recreate jsconfig.json with current settings
            const now2 = new Date();
            const selectedP5VersionRJ = cfg.getP5jsVersion();
            let p5typesCandidatesRJ: string[];
            if (selectedP5VersionRJ === '1.11') {
                p5typesCandidatesRJ = [path.join(context.extensionPath, 'assets', '1.11', 'p5types', 'global.d.ts')];
            } else {
                p5typesCandidatesRJ = [path.join(context.extensionPath, 'assets', selectedP5VersionRJ, 'p5types', 'global.d.ts')];
            }
            let p5helperCandidatesRJ: string[];
            if (selectedP5VersionRJ === '1.11') {
                p5helperCandidatesRJ = [path.join(context.extensionPath, 'assets', '1.11', 'p5types', 'p5helper.d.ts')];
            } else {
                p5helperCandidatesRJ = [path.join(context.extensionPath, 'assets', selectedP5VersionRJ, 'p5types', 'p5helper.d.ts')];
            }
            const resolvedGlobalRJ = p5typesCandidatesRJ.find(p => { try { return fs.existsSync(p); } catch { return false; } });
            const resolvedHelperRJ = p5helperCandidatesRJ.find(p => { try { return fs.existsSync(p); } catch { return false; } });
            const jsconfig = {
                createdAt: toLocalISOString(now2),
                projectType: 'p5js',
                include: ((): string[] => {
                    const base = [
                        'sketches/**/*.js',
                        'include/**/*.js',
                        'import/**/*.js',
                        'common/**/*.js',
                        'include/**/*.d.ts',
                        'import/**/*.d.ts',
                        'common/**/*.d.ts',
                    ];
                    if (resolvedGlobalRJ) base.push(resolvedGlobalRJ);
                    if (resolvedHelperRJ) base.push(resolvedHelperRJ);
                    return base;
                })()
            } as any;
            writeFileSync(jsconfigPath, JSON.stringify(jsconfig, null, 2));
            if (selectedP5VersionRJ !== '1.11' && (!resolvedGlobalRJ || !resolvedHelperRJ)) {
                console.warn('[P5Studio] No p5types found for version', selectedP5VersionRJ, '- jsconfig will omit type definitions.');
            }
        }
    } catch (e) {
        console.warn('Failed to refresh jsconfig.json on activation:', e);
    }
}

async function showSetupNotificationIfNeeded() {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) return;

    const showSetupNotification = cfg.getShowSetupNotification();
    if (!showSetupNotification) return;

    // Check for jsconfig.json with projectType: 'p5js' at the root
    const jsconfigPath = path.join(workspaceFolder.uri.fsPath, 'jsconfig.json');
    let isP5Project = false;
    if (fs.existsSync(jsconfigPath)) {
        try {
            const jsconfigRaw = fs.readFileSync(jsconfigPath, 'utf8');
            const jsconfig = JSON.parse(jsconfigRaw);
            if (jsconfig && jsconfig.projectType === 'p5js') {
                isP5Project = true;
            }
        } catch { /* ignore parse errors */ }
    }
    if (!isP5Project) {
        const action = await vscode.window.showInformationMessage(
            "This project isn't configured for P5 yet. Would you like to set it up now?",
            'Setup P5 Project',
            "Don't show again",
        );
        if (action === 'Setup P5 Project') {
            vscode.commands.executeCommand('extension.create-jsconfig');
        } else if (action === "Don't show again") {
            await cfg.setShowSetupNotification(false);
        }
    }
}

export function runOnActivate(context: vscode.ExtensionContext) {
    // Run both utilities without blocking activation
    (async () => { try { await refreshJsconfigIfMarkerPresent(context); } catch { } })();
    (async () => { try { await showSetupNotificationIfNeeded(); } catch { } })();
}
