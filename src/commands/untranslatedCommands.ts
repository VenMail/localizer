/**
 * Re-export for backwards compatibility.
 * 
 * Module structure:
 * - untranslated/index.ts - Main facade class (UntranslatedCommands)
 * - untranslated/handlers/ - Specialized command handlers
 *   - gitRecoveryHandler.ts - Git history recovery logic
 *   - translationHandler.ts - AI translation operations
 *   - keyManagementHandler.ts - Key add/remove/restore operations
 *   - cleanupHandler.ts - Unused/invalid key cleanup
 *   - styleHandler.ts - Style suggestion operations
 *   - reportHandler.ts - Report management operations
 * - untranslated/utils/ - Shared utilities
 *   - jsonUtils.ts - JSON path operations
 *   - textAnalysis.ts - Text analysis and scoring
 *   - diagnosticParser.ts - Diagnostic message parsing
 *   - commentParser.ts - Comment detection
 */
export { UntranslatedCommands } from './untranslated';
