import * as vscode from 'vscode';
import { TextDecoder, TextEncoder } from 'util';

export const sharedDecoder = new TextDecoder('utf-8');
export const sharedEncoder = new TextEncoder();

// Simple file-level mutex for preventing concurrent writes to the same file
const fileMutex = new Map<string, Promise<void>>();
const mutexTimeout = 30000; // 30 second max wait

/**
 * Execute an operation with file-level locking to prevent race conditions
 */
export async function withFileMutex<T>(fileUri: vscode.Uri, operation: () => Promise<T>): Promise<T> {
    const key = fileUri.toString();
    
    // Wait for any existing operation on this file
    let existing = fileMutex.get(key);
    if (existing) {
        const timeoutPromise = new Promise<void>((_, reject) => {
            setTimeout(() => reject(new Error(`File lock timeout: ${fileUri.fsPath}`)), mutexTimeout);
        });
        try {
            await Promise.race([existing, timeoutPromise]);
        } catch {
            // Previous operation timed out or failed, proceed anyway
        }
    }
    
    // Create our lock
    let resolver: () => void;
    const ourLock = new Promise<void>((resolve) => {
        resolver = resolve;
    });
    fileMutex.set(key, ourLock);
    
    try {
        return await operation();
    } finally {
        resolver!();
        // Only delete if it's still our lock (prevent race with next operation)
        if (fileMutex.get(key) === ourLock) {
            fileMutex.delete(key);
        }
    }
}

/**
 * Check if a key path exists in a JSON object
 */
export function hasKeyPathInObject(obj: any, keyPath: string): boolean {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
    const segments = String(keyPath).split('.').filter(Boolean);
    if (!segments.length) return false;

    let node = obj;
    for (const segment of segments) {
        if (!node || typeof node !== 'object' || Array.isArray(node)) {
            return false;
        }
        if (!Object.prototype.hasOwnProperty.call(node, segment)) {
            return false;
        }
        node = node[segment];
    }
    return true;
}

/**
 * Delete a key path from a JSON object
 * Returns true if the key was deleted
 */
export function deleteKeyPathInObject(obj: any, keyPath: string): boolean {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
    const segments = String(keyPath).split('.').filter(Boolean);
    if (!segments.length) return false;

    let deleted = false;

    const helper = (target: any, index: number): boolean => {
        if (!target || typeof target !== 'object' || Array.isArray(target)) {
            return false;
        }
        const key = segments[index];
        if (index === segments.length - 1) {
            if (!Object.prototype.hasOwnProperty.call(target, key)) {
                return false;
            }
            delete target[key];
            deleted = true;
            return Object.keys(target).length === 0;
        }
        if (!Object.prototype.hasOwnProperty.call(target, key)) {
            return false;
        }
        const child = target[key];
        const shouldDeleteChild = helper(child, index + 1);
        if (shouldDeleteChild) {
            delete target[key];
        }
        return Object.keys(target).length === 0;
    };

    helper(obj, 0);
    return deleted;
}

/**
 * Get nested value from object using dot notation path
 */
export function getNestedValue(obj: any, path: string): any {
    const segments = path.split('.').filter(Boolean);
    let current = obj;
    for (const segment of segments) {
        if (!current || typeof current !== 'object' || Array.isArray(current)) {
            return undefined;
        }
        if (!Object.prototype.hasOwnProperty.call(current, segment)) {
            return undefined;
        }
        current = current[segment];
    }
    return current;
}

/**
 * Set nested value in object using dot notation path
 */
export function setNestedValue(obj: any, path: string, value: any): void {
    const segments = path.split('.').filter(Boolean);
    let current = obj;
    for (let i = 0; i < segments.length - 1; i++) {
        const segment = segments[i];
        if (!current[segment] || typeof current[segment] !== 'object' || Array.isArray(current[segment])) {
            current[segment] = {};
        }
        current = current[segment];
    }
    current[segments[segments.length - 1]] = value;
}

/**
 * Ensure deep container exists in object for a key path
 */
export function ensureDeepContainer(obj: any, segments: string[]): any {
    let node: any = obj;
    for (const seg of segments) {
        if (!node || typeof node !== 'object') break;
        if (
            !Object.prototype.hasOwnProperty.call(node, seg) ||
            typeof node[seg] !== 'object' ||
            Array.isArray(node[seg])
        ) {
            node[seg] = {};
        }
        node = node[seg];
    }
    return node;
}

/**
 * Read and parse a JSON file
 */
export async function readJsonFile(uri: vscode.Uri): Promise<any> {
    try {
        const data = await vscode.workspace.fs.readFile(uri);
        const raw = sharedDecoder.decode(data);
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

/**
 * Write a JSON object to a file with file-level locking
 */
export async function writeJsonFile(uri: vscode.Uri, obj: any): Promise<void> {
    await withFileMutex(uri, async () => {
        const payload = `${JSON.stringify(obj, null, 2)}\n`;
        await vscode.workspace.fs.writeFile(uri, sharedEncoder.encode(payload));
    });
}

/**
 * Set multiple values in a JSON file with file-level locking
 */
export async function setMultipleInFile(fileUri: vscode.Uri, updates: Map<string, string>): Promise<void> {
    await withFileMutex(fileUri, async () => {
        let root: any = await readJsonFile(fileUri) || {};
        if (!root || typeof root !== 'object' || Array.isArray(root)) root = {};

        for (const [fullKey, value] of updates.entries()) {
            const segments = fullKey.split('.').filter(Boolean);
            const container = ensureDeepContainer(root, segments.slice(0, -1));
            const last = segments[segments.length - 1];
            container[last] = value;
        }

        // Direct write (already inside mutex, avoid nested lock)
        const payload = `${JSON.stringify(root, null, 2)}\n`;
        await vscode.workspace.fs.writeFile(fileUri, sharedEncoder.encode(payload));
    });
}

