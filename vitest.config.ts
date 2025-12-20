import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
    test: {
        environment: 'node',
        globals: true,
        coverage: {
            reporter: ['text', 'lcov'],
        },
        include: ['tests/**/*.test.ts'],
    },
    resolve: {
        alias: {
            vscode: path.resolve(__dirname, 'tests/mocks/vscode.ts'),
        },
    },
});
