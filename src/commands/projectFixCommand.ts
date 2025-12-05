import * as vscode from 'vscode';
import { I18nIndex } from '../core/i18nIndex';
import { TranslationService } from '../services/translationService';
import { ProjectConfigService } from '../services/projectConfigService';
import { pickWorkspaceFolder, runI18nScript } from '../core/workspace';
import { getGitStatus, createSnapshotCommit } from '../core/gitMonitor';

export class ProjectFixCommand {
    constructor(
        private context: vscode.ExtensionContext,
        private i18nIndex: I18nIndex,
        private translationService: TranslationService,
        private projectConfigService: ProjectConfigService,
    ) {}

    async execute(): Promise<void> {
        try {
            const folder = await pickWorkspaceFolder();
            if (!folder) {
                vscode.window.showInformationMessage('AI Localizer: No workspace folder available.');
                return;
            }

            const hasScripts = await this.projectConfigService.hasI18nScripts(folder);
            if (!hasScripts) {
                const setupChoice = await vscode.window.showQuickPick(
                    [
                        {
                            label: 'Configure project i18n and continue',
                            description: 'Copy scripts into this project and update package.json scripts.',
                        },
                        {
                            label: 'Cancel',
                            description: 'Do not run project-wide fixes right now.',
                        },
                    ],
                    {
                        placeHolder:
                            'AI Localizer: Project i18n scripts are not configured for this workspace. Configure them now?',
                    },
                );

                if (!setupChoice || setupChoice.label !== 'Configure project i18n and continue') {
                    return;
                }

                await vscode.commands.executeCommand('ai-localizer.i18n.configureProject');
            }

            const status = await getGitStatus(folder);
            if (!status.hasGit) {
                const choice = await vscode.window.showQuickPick(
                    [
                        {
                            label: 'Continue without git snapshot',
                            description: 'Run project-wide fixes without creating a git commit.',
                        },
                        {
                            label: 'Cancel',
                            description: 'Do not run project-wide fixes right now.',
                        },
                    ],
                    {
                        placeHolder:
                            'AI Localizer: No git repository detected for this workspace. Continue without a snapshot commit?',
                    },
                );

                if (!choice || choice.label !== 'Continue without git snapshot') {
                    return;
                }
            } else if (status.isDirty) {
                const choice = await vscode.window.showQuickPick(
                    [
                        {
                            label: 'Create snapshot commit and continue',
                            description:
                                'Stage tracked changes, create a git commit, and then run project-wide i18n fixes.',
                        },
                        {
                            label: 'Continue without snapshot (not recommended)',
                            description:
                                'Run project-wide i18n fixes without taking a snapshot git commit first.',
                        },
                        {
                            label: 'Cancel',
                            description: 'Do not run project-wide fixes right now.',
                        },
                    ],
                    {
                        placeHolder:
                            'AI Localizer: Workspace has uncommitted changes. Create a snapshot git commit before running project-wide i18n fixes?',
                    },
                );

                if (!choice || choice.label === 'Cancel') {
                    return;
                }

                if (choice.label === 'Create snapshot commit and continue') {
                    const snapshot = await createSnapshotCommit(
                        folder,
                        'chore: i18n pre-cleanup snapshot',
                    );
                    if (!snapshot.success) {
                        const message = snapshot.error
                            ? `AI Localizer: Failed to create git snapshot commit. ${snapshot.error}`
                            : 'AI Localizer: Failed to create git snapshot commit.';
                        vscode.window.showErrorMessage(message);
                        return;
                    }
                }
            }

            const confirm = await vscode.window.showQuickPick(
                [
                    {
                        label: 'Run full project-wide i18n cleanup',
                        description:
                            'Run extract, rewrite, sync, AI fixes, and cleanup unused/invalid keys for this workspace.',
                    },
                    {
                        label: 'Cancel',
                        description: 'Do not run project-wide fixes right now.',
                    },
                ],
                {
                    placeHolder:
                        'AI Localizer: Fix all i18n issues in this project (one-time cleanup)?',
                },
            );

            if (!confirm || confirm.label !== 'Run full project-wide i18n cleanup') {
                return;
            }

            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'AI Localizer: Fixing all i18n issues in project...',
                    cancellable: true,
                },
                async (progress, token) => {
                    if (token.isCancellationRequested) {
                        return;
                    }

                    progress.report({ message: 'Extracting translatable strings (i18n:extract)...' });
                    await vscode.commands.executeCommand('ai-localizer.i18n.runExtractScript');
                    if (token.isCancellationRequested) {
                        return;
                    }

                    progress.report({ message: 'Rewriting source to use t() calls (i18n:rewrite)...' });
                    await vscode.commands.executeCommand('ai-localizer.i18n.runRewriteScript');
                    if (token.isCancellationRequested) {
                        return;
                    }

                    progress.report({ message: 'Rewriting Blade templates (i18n:rewrite-blade)...' });
                    await vscode.commands.executeCommand('ai-localizer.i18n.runRewriteBladeScript');
                    if (token.isCancellationRequested) {
                        return;
                    }

                    progress.report({ message: 'Syncing locales (i18n:sync)...' });
                    await vscode.commands.executeCommand('ai-localizer.i18n.runSyncScript');
                    if (token.isCancellationRequested) {
                        return;
                    }

                    progress.report({ message: 'Detecting untranslated strings (i18n:fix-untranslated)...' });
                    await vscode.commands.executeCommand('ai-localizer.i18n.runFixUntranslatedScript');
                    if (token.isCancellationRequested) {
                        return;
                    }

                    progress.report({ message: 'Cleaning up unused keys across locales (i18n:cleanup-unused --apply)...' });
                    await runI18nScript('i18n:cleanup-unused', {
                        folder,
                        extraArgs: ['--apply'],
                    });
                    if (token.isCancellationRequested) {
                        return;
                    }

                    progress.report({ message: 'Restoring invalid/non-translatable keys (i18n:restore-invalid --apply)...' });
                    await runI18nScript('i18n:restore-invalid', {
                        folder,
                        extraArgs: ['--apply'],
                    });
                    if (token.isCancellationRequested) {
                        return;
                    }

                    progress.report({ message: 'Rebuilding translation index and diagnostics...' });
                    await this.i18nIndex.ensureInitialized(true);
                    await vscode.commands.executeCommand('ai-localizer.i18n.rescan');

                    if (token.isCancellationRequested) {
                        return;
                    }

                    await vscode.commands.executeCommand('ai-localizer.i18n.showHealthReport');
                },
            );

            const apiKey = (await this.translationService.getApiKey())?.trim();
            const extraNote = apiKey
                ? 'AI translation was enabled for this run; review locale files and diffs as needed.'
                : 'No OpenAI API key was configured; missing translations were not auto-filled by AI.';

            vscode.window.showInformationMessage(
                `AI Localizer: Project-wide i18n cleanup completed for workspace "${folder.name}". ${extraNote}`,
            );
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error('AI Localizer: Failed to run project-wide i18n cleanup:', err);
            vscode.window.showErrorMessage(
                `AI Localizer: Failed to run project-wide i18n cleanup. ${msg}`,
            );
        }
    }
}
