/**
 * Framework-specific code generation utility
 * Extracted from ConvertSelectionCommand to improve organization and reusability
 */

import * as vscode from 'vscode';
import { TemplateLiteralProcessor, TemplateInfo } from './TemplateLiteralProcessor';

export interface CodeGenerationOptions {
    document: vscode.TextDocument;
    range: vscode.Range;
    key: string;
    templateInfo?: TemplateInfo | null;
    isJsSource?: boolean;
}

export class FrameworkCodeGenerator {
    /**
     * Generate framework-specific replacement code
     */
    static generateReplacement(options: CodeGenerationOptions): string {
        const { document, range, key, templateInfo, isJsSource } = options;
        const langId = document.languageId;

        const isJsLike = ['javascript', 'typescript', 'javascriptreact', 'typescriptreact'].includes(langId);
        const isVueLike = langId === 'vue';
        const isBladeLike = langId === 'blade' || langId === 'php';

        if (isBladeLike) {
            return `{{ __('${key}') }}`;
        }

        if (isVueLike) {
            return `{{$t('${key}')}}`;
        }

        // JavaScript/TypeScript
        let replacement = `t('${key}')`;
        if (isJsSource && templateInfo && templateInfo.placeholders.length > 0) {
            const argsObject = templateInfo.placeholders
                .map(p => `${p.name}: ${p.expression}`)
                .join(', ');
            if (argsObject.length > 0) {
                replacement = `t('${key}', { ${argsObject} })`;
            }
        }

        return replacement;
    }

    /**
     * Create workspace edit for framework-specific replacement
     */
    static createEdit(options: CodeGenerationOptions): vscode.WorkspaceEdit {
        const edit = new vscode.WorkspaceEdit();
        const replacement = this.generateReplacement(options);
        edit.replace(options.document.uri, options.range, replacement);
        return edit;
    }

    /**
     * Add import statement if needed for JavaScript/TypeScript files
     */
    static addImportIfNeeded(
        document: vscode.TextDocument,
        edit: vscode.WorkspaceEdit,
        tImportPath: string = '@/i18n'
    ): void {
        const langId = document.languageId;
        const isJsLike = ['javascript', 'typescript', 'javascriptreact', 'typescriptreact'].includes(langId);
        const isVueLike = langId === 'vue';
        const isBladeLike = langId === 'blade' || langId === 'php';

        // Only add imports for JS-like files (excluding Vue and Blade)
        if (!isJsLike || isVueLike || isBladeLike) {
            return;
        }

        const fullText = document.getText();
        const hasTImport =
            fullText.includes(`import { t } from '${tImportPath}'`) ||
            fullText.includes(`import { t } from "${tImportPath}"`);

        if (!hasTImport) {
            const importLine = `import { t } from '${tImportPath}';\n`;
            const insertPos = this.findImportInsertPosition(document);
            edit.insert(document.uri, insertPos, importLine);
        }
    }

    /**
     * Find the best position to insert import statement
     */
    private static findImportInsertPosition(document: vscode.TextDocument): vscode.Position {
        let lastImportLine = -1;
        let firstCodeLine = -1;

        for (let i = 0; i < document.lineCount; i++) {
            const lineText = document.lineAt(i).text;
            const trimmed = lineText.trim();

            // Skip empty lines and comments
            if (
                !trimmed ||
                trimmed.startsWith('//') ||
                trimmed.startsWith('/*') ||
                trimmed.startsWith('*')
            ) {
                continue;
            }

            if (trimmed.startsWith('import ') || trimmed.startsWith('import{')) {
                lastImportLine = i;
            } else if (firstCodeLine === -1) {
                firstCodeLine = i;
            }
        }

        // Insert after last import, or before first code line, or at the beginning
        if (lastImportLine >= 0) {
            return new vscode.Position(lastImportLine + 1, 0);
        } else if (firstCodeLine >= 0) {
            return new vscode.Position(firstCodeLine, 0);
        }

        return new vscode.Position(0, 0);
    }

    /**
     * Get framework-specific import path
     */
    static getImportPath(document: vscode.TextDocument): string {
        const config = vscode.workspace.getConfiguration('ai-localizer');
        return config.get<string>('i18n.tImportPath') || '@/i18n';
    }

    /**
     * Check if file needs import handling
     */
    static needsImportHandling(document: vscode.TextDocument): boolean {
        const langId = document.languageId;
        const isJsLike = ['javascript', 'typescript', 'javascriptreact', 'typescriptreact'].includes(langId);
        const isVueLike = langId === 'vue';
        const isBladeLike = langId === 'blade' || langId === 'php';
        
        return isJsLike && !isVueLike && !isBladeLike;
    }

    /**
     * Analyze template literal for JS source files
     */
    static analyzeTemplateLiteral(document: vscode.TextDocument, range: vscode.Range): TemplateInfo | null {
        const rawLiteral = document.getText(range);
        return TemplateLiteralProcessor.analyze(rawLiteral);
    }

    /**
     * Validate generated code for common issues
     */
    static validateGeneratedCode(code: string, framework: string): { isValid: boolean; issues: string[] } {
        const issues: string[] = [];

        if (!code || typeof code !== 'string') {
            issues.push('Generated code is empty or invalid');
            return { isValid: false, issues };
        }

        // Framework-specific validation
        switch (framework) {
            case 'vue':
                if (!code.includes('{$t(')) {
                    issues.push('Vue code should use {$t()} syntax');
                }
                break;
            case 'blade':
                if (!code.includes('{{ __(')) {
                    issues.push('Blade code should use {{ __() }} syntax');
                }
                break;
            case 'js':
            case 'ts':
            case 'jsx':
            case 'tsx':
                if (!code.includes('t(')) {
                    issues.push('JS/TS code should use t() function');
                }
                break;
        }

        return { isValid: issues.length === 0, issues };
    }

    /**
     * Get framework name from document
     */
    static getFrameworkName(document: vscode.TextDocument): string {
        const langId = document.languageId;
        
        switch (langId) {
            case 'vue': return 'vue';
            case 'blade': return 'blade';
            case 'php': return 'blade';
            case 'javascript': return 'js';
            case 'typescript': return 'ts';
            case 'javascriptreact': return 'jsx';
            case 'typescriptreact': return 'tsx';
            default: return 'unknown';
        }
    }
}
