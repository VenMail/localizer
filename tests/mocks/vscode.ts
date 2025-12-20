const encoder = new TextEncoder();

export const workspace = {
    getConfiguration: () => ({ get: () => undefined }),
    workspaceFolders: [],
    fs: {
        readFile: async () => encoder.encode(''),
        writeFile: async () => undefined,
        stat: async () => ({ type: 0, ctime: 0, mtime: 0, size: 0 }),
    },
    getWorkspaceFolder: () => ({ uri: Uri.file('/') }),
};

export enum ViewColumn {
    Active = -1,
    Beside = -2,
    One = 1,
    Two,
    Three,
}

type OutputChannelShow = {
    (preserveFocus?: boolean): void;
    (column?: ViewColumn, preserveFocus?: boolean): void;
};

export class MockOutputChannel {
    public readonly name = 'mock-output';
    public lines: string[] = [];
    appendLine(message: string): void {
        this.lines.push(message);
    }
    append(message: string): void {
        this.lines.push(message);
    }
    replace(message: string): void {
        if (this.lines.length) {
            this.lines[this.lines.length - 1] = message;
        } else {
            this.lines.push(message);
        }
    }
    clear(): void {
        this.lines = [];
    }
    show: OutputChannelShow = (_columnOrFocus?: boolean | ViewColumn, _preserveFocus?: boolean) => {};
    hide(): void {}
    dispose(): void {}
}

export const window = {
    showInformationMessage: (..._args: unknown[]) => undefined,
    showQuickPick: async () => undefined,
    showInputBox: async () => undefined,
    visibleTextEditors: [],
    createOutputChannel: () => new MockOutputChannel(),
};

export const commands = {
    registerCommand: () => ({ dispose: () => undefined }),
    executeCommand: async () => undefined,
};

export class Uri {
    constructor(public fsPath: string) {}

    toString(): string {
        return this.fsPath.startsWith('file://') ? this.fsPath : `file://${this.fsPath}`;
    }

    with(params: { path?: string }): Uri {
        const nextPath = params.path ?? this.fsPath;
        return new Uri(nextPath);
    }

    static file(pathValue: string): Uri {
        return new Uri(pathValue);
    }

    static parse(pathValue: string): Uri {
        const normalized = pathValue.replace(/^file:\/\//, '');
        return new Uri(normalized);
    }

    static joinPath(...parts: Array<{ fsPath?: string } | string>): Uri {
        const combined = parts
            .map((p) => (typeof p === 'string' ? p : p?.fsPath ?? ''))
            .filter(Boolean)
            .join('/');
        return new Uri(combined);
    }
}

export const DiagnosticSeverity = {
    Error: 0,
    Warning: 1,
    Information: 2,
    Hint: 3,
} as const;

export class Diagnostic {
    code?: string;
    source?: string;
    constructor(public range: Range, public message: string, public severity: number) {}
}

export class DiagnosticCollection {
    clear(): void {}
    set(): void {}
    delete(): void {}
}

export const languages = {
    createDiagnosticCollection: () => new DiagnosticCollection(),
};

export const workspaceFolders = [];

export class Position {
    constructor(public line: number, public character: number) {}
}

export class Range {
    constructor(public start: Position, public end: Position) {}
}

export class WorkspaceEdit {
    private operations: Array<
        | { type: 'replace'; uri: { fsPath: string }; range: Range; text: string }
        | { type: 'insert'; uri: { fsPath: string }; position: Position; text: string }
    > = [];

    replace(uri: { fsPath: string }, range: Range, text: string): void {
        this.operations.push({ type: 'replace', uri, range, text });
    }

    insert(uri: { fsPath: string }, position: Position, text: string): void {
        this.operations.push({ type: 'insert', uri, position, text });
    }

    getOperations(): typeof this.operations {
        return this.operations;
    }
}
