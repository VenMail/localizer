/**
 * Key Management Module
 * 
 * This module provides a modular, atomic architecture for key management operations.
 * It replaces the monolithic KeyManagementHandler with specialized components.
 */

export { TranslationOperations } from './translationOperations';
export { BulkOperations } from './bulkOperations';
export { ValidationModule } from './validationModule';
export { KeyManagementHandler } from './keyManagementHandler';

// Re-export types for convenience
export type { 
    ValidationResult,
    CopyTranslationParams,
    BulkOperationParams 
} from './validationModule';

export type { 
    BulkOperationResult 
} from './bulkOperations';
