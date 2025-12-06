import * as vscode from 'vscode';

/**
 * Operation types for categorizing locks
 */
export type OperationType = 
    | 'translation-project'
    | 'translation-file'
    | 'cleanup-unused'
    | 'cleanup-invalid'
    | 'key-management'
    | 'style-fix';

interface OperationState {
    type: OperationType;
    description: string;
    startTime: number;
    cancellationToken?: vscode.CancellationTokenSource;
}

/**
 * File-level lock entry
 */
interface FileLock {
    uri: string;
    holder: OperationType;
    timestamp: number;
}

/**
 * Singleton class managing operation locks to prevent race conditions
 * between concurrent i18n operations that modify locale files.
 */
class OperationLockManager {
    private static instance: OperationLockManager;
    
    private globalLock: OperationState | null = null;
    private fileLocks = new Map<string, FileLock>();
    private waitingOperations: Array<{
        resolve: () => void;
        reject: (err: Error) => void;
        type: OperationType;
    }> = [];
    
    private readonly lockTimeout = 300000; // 5 minutes max lock duration
    private readonly fileWriteDelay = 50; // ms delay between consecutive file writes
    private lastFileWrite = 0;

    private constructor() {}

    static getInstance(): OperationLockManager {
        if (!OperationLockManager.instance) {
            OperationLockManager.instance = new OperationLockManager();
        }
        return OperationLockManager.instance;
    }

    /**
     * Check if a global operation is currently running
     */
    isOperationRunning(): boolean {
        if (!this.globalLock) return false;
        
        // Auto-release stale locks
        if (Date.now() - this.globalLock.startTime > this.lockTimeout) {
            console.warn(`AI Localizer: Auto-releasing stale lock for ${this.globalLock.type}`);
            this.releaseGlobalLock(this.globalLock.type);
            return false;
        }
        return true;
    }

    /**
     * Get the current operation state if any
     */
    getCurrentOperation(): OperationState | null {
        if (!this.isOperationRunning()) return null;
        return this.globalLock;
    }

    /**
     * Get human-readable description of the blocking operation
     */
    getBlockingOperationMessage(): string {
        const op = this.getCurrentOperation();
        if (!op) return '';
        
        const elapsed = Math.round((Date.now() - op.startTime) / 1000);
        return `"${op.description}" is in progress (${elapsed}s elapsed)`;
    }

    /**
     * Acquire global lock for a major operation.
     * Returns true if lock acquired, false if another operation is running.
     */
    async acquireGlobalLock(
        type: OperationType,
        description: string,
        options?: { 
            wait?: boolean; 
            timeout?: number;
            cancellationToken?: vscode.CancellationTokenSource;
        }
    ): Promise<boolean> {
        // Clean up stale locks first
        this.cleanupStaleLocks();

        if (!this.globalLock) {
            this.globalLock = {
                type,
                description,
                startTime: Date.now(),
                cancellationToken: options?.cancellationToken,
            };
            return true;
        }

        // Same operation type can proceed (nested calls)
        if (this.globalLock.type === type) {
            return true;
        }

        if (!options?.wait) {
            return false;
        }

        // Wait for lock to become available
        const timeout = options.timeout || 30000;
        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                const idx = this.waitingOperations.findIndex(
                    (w) => w.resolve === resolve
                );
                if (idx !== -1) {
                    this.waitingOperations.splice(idx, 1);
                }
                reject(new Error(`Timeout waiting for lock: ${this.getBlockingOperationMessage()}`));
            }, timeout);

            this.waitingOperations.push({
                resolve: () => {
                    clearTimeout(timeoutId);
                    this.globalLock = {
                        type,
                        description,
                        startTime: Date.now(),
                        cancellationToken: options?.cancellationToken,
                    };
                    resolve(true);
                },
                reject: (err) => {
                    clearTimeout(timeoutId);
                    reject(err);
                },
                type,
            });
        });
    }

    /**
     * Release global lock
     */
    releaseGlobalLock(type: OperationType): void {
        if (this.globalLock?.type === type) {
            this.globalLock = null;
            
            // Notify next waiting operation
            const next = this.waitingOperations.shift();
            if (next) {
                setImmediate(() => next.resolve());
            }
        }
    }

    /**
     * Acquire file-level lock for writing
     */
    async acquireFileLock(uri: vscode.Uri, holder: OperationType): Promise<boolean> {
        const key = uri.toString();
        const existing = this.fileLocks.get(key);
        
        if (existing) {
            // Check if lock is stale (> 30 seconds)
            if (Date.now() - existing.timestamp > 30000) {
                console.warn(`AI Localizer: Releasing stale file lock for ${uri.fsPath}`);
                this.fileLocks.delete(key);
            } else if (existing.holder !== holder) {
                return false;
            }
        }

        // Throttle consecutive file writes to prevent overwhelming the file system
        const now = Date.now();
        const timeSinceLastWrite = now - this.lastFileWrite;
        if (timeSinceLastWrite < this.fileWriteDelay) {
            await new Promise(resolve => setTimeout(resolve, this.fileWriteDelay - timeSinceLastWrite));
        }

        this.fileLocks.set(key, {
            uri: key,
            holder,
            timestamp: Date.now(),
        });
        return true;
    }

    /**
     * Release file-level lock
     */
    releaseFileLock(uri: vscode.Uri): void {
        this.lastFileWrite = Date.now();
        this.fileLocks.delete(uri.toString());
    }

    /**
     * Execute a function with file lock protection
     */
    async withFileLock<T>(
        uri: vscode.Uri,
        holder: OperationType,
        fn: () => Promise<T>
    ): Promise<T> {
        const acquired = await this.acquireFileLock(uri, holder);
        if (!acquired) {
            throw new Error(`Cannot acquire file lock for ${uri.fsPath}`);
        }
        try {
            return await fn();
        } finally {
            this.releaseFileLock(uri);
        }
    }

    /**
     * Execute a function with global lock protection
     */
    async withGlobalLock<T>(
        type: OperationType,
        description: string,
        fn: (token?: vscode.CancellationToken) => Promise<T>,
        options?: {
            showBlockingMessage?: boolean;
            cancellable?: boolean;
        }
    ): Promise<T | null> {
        const cancellationToken = options?.cancellable 
            ? new vscode.CancellationTokenSource() 
            : undefined;

        const acquired = await this.acquireGlobalLock(type, description, {
            cancellationToken,
        });

        if (!acquired) {
            if (options?.showBlockingMessage !== false) {
                const blockingMsg = this.getBlockingOperationMessage();
                vscode.window.showWarningMessage(
                    `AI Localizer: Cannot start "${description}" - ${blockingMsg}. Please wait for it to complete or cancel it.`
                );
            }
            return null;
        }

        try {
            return await fn(cancellationToken?.token);
        } finally {
            this.releaseGlobalLock(type);
            cancellationToken?.dispose();
        }
    }

    /**
     * Clean up stale locks
     */
    private cleanupStaleLocks(): void {
        const now = Date.now();
        
        // Clean stale file locks
        for (const [key, lock] of this.fileLocks.entries()) {
            if (now - lock.timestamp > 30000) {
                this.fileLocks.delete(key);
            }
        }

        // Clean stale global lock
        if (this.globalLock && now - this.globalLock.startTime > this.lockTimeout) {
            console.warn(`AI Localizer: Auto-releasing stale global lock for ${this.globalLock.type}`);
            this.globalLock = null;
        }
    }

    /**
     * Force release all locks (emergency cleanup)
     */
    forceReleaseAll(): void {
        this.globalLock = null;
        this.fileLocks.clear();
        
        // Reject all waiting operations
        for (const waiting of this.waitingOperations) {
            waiting.reject(new Error('All locks force released'));
        }
        this.waitingOperations = [];
    }

    /**
     * Get lock statistics for debugging
     */
    getStats(): { globalLock: OperationState | null; fileLockCount: number; waitingCount: number } {
        return {
            globalLock: this.globalLock,
            fileLockCount: this.fileLocks.size,
            waitingCount: this.waitingOperations.length,
        };
    }
}

// Export singleton instance
export const operationLock = OperationLockManager.getInstance();

/**
 * Decorator/helper to wrap async operations with lock protection
 */
export function withOperationLock<T extends (...args: any[]) => Promise<any>>(
    type: OperationType,
    description: string | ((...args: Parameters<T>) => string),
    options?: { showBlockingMessage?: boolean }
) {
    return function (
        _target: any,
        _propertyKey: string,
        descriptor: TypedPropertyDescriptor<T>
    ) {
        const originalMethod = descriptor.value!;
        
        descriptor.value = async function (this: any, ...args: Parameters<T>) {
            const desc = typeof description === 'function' 
                ? description(...args) 
                : description;

            const result = await operationLock.withGlobalLock(
                type,
                desc,
                () => originalMethod.apply(this, args),
                options
            );
            
            return result;
        } as T;
        
        return descriptor;
    };
}

/**
 * Check if operation can proceed, showing warning if blocked
 */
export async function canProceedWithOperation(
    type: OperationType,
    description: string
): Promise<boolean> {
    if (!operationLock.isOperationRunning()) {
        return true;
    }

    const current = operationLock.getCurrentOperation();
    if (current?.type === type) {
        // Same operation type - allow nested calls
        return true;
    }

    const blockingMsg = operationLock.getBlockingOperationMessage();
    const choice = await vscode.window.showWarningMessage(
        `AI Localizer: Cannot start "${description}" - ${blockingMsg}.`,
        'Wait',
        'Cancel'
    );

    return choice === 'Wait';
}




