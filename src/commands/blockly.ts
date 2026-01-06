import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { config as cfg } from '../config';

export function registerBlocklyCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('extension.open-blockly-json', async () => {
      try {
        const selectedP5Version = cfg.getP5jsVersion();
        const versioned = path.join(context.extensionPath, 'assets', selectedP5Version, 'blockly_categories.json');
        const defaultFallback = path.join(context.extensionPath, 'assets', '1.11', 'blockly_categories.json');
        const kidsFallback = path.join(context.extensionPath, 'assets', '1.11', 'blockly_kids_categories.json');
        const legacy = path.join(context.extensionPath, 'blockly', 'blockly_categories.json');
        const preferKidsCategories = cfg.getBlocklyKidsMode();
        const candidates = preferKidsCategories
          ? [kidsFallback, versioned, defaultFallback, legacy]
          : [versioned, defaultFallback, legacy];
        const chosen = candidates.find(candidate => candidate && fs.existsSync(candidate)) ?? legacy;
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(chosen));
        await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false, viewColumn: vscode.ViewColumn.One });
      } catch (e) {
        vscode.window.showErrorMessage('Could not open blockly_categories.json');
      }
    })
  );
}
