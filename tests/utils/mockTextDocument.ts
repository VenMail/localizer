import { Position, Range } from 'vscode';

export class MockTextDocument {
    private lines: string[];
    public readonly uri: { fsPath: string };

    constructor(private text: string, public languageId = 'typescript', fileName = 'mock.ts') {
        this.lines = text.split(/\r?\n/);
        this.uri = { fsPath: fileName };
    }

    getText(range?: Range): string {
        if (!range) {
            return this.text;
        }
        const start = this.offsetAt(range.start);
        const end = this.offsetAt(range.end);
        return this.text.slice(start, end);
    }

    offsetAt(position: Position): number {
        let offset = 0;
        for (let i = 0; i < position.line; i += 1) {
            offset += this.lines[i]?.length ?? 0;
            offset += 1; // newline
        }
        return offset + position.character;
    }

    positionAt(offset: number): Position {
        let remaining = offset;
        for (let i = 0; i < this.lines.length; i += 1) {
            const lineLength = this.lines[i].length + 1; // include newline
            if (remaining < lineLength) {
                return new Position(i, Math.min(remaining, this.lines[i].length));
            }
            remaining -= lineLength;
        }
        const lastLineIndex = Math.max(0, this.lines.length - 1);
        return new Position(lastLineIndex, this.lines[lastLineIndex]?.length ?? 0);
    }

    lineAt(index: number): { text: string; range: Range } {
        const text = this.lines[index] ?? '';
        return {
            text,
            range: new Range(new Position(index, 0), new Position(index, text.length)),
        };
    }

    get lineCount(): number {
        return this.lines.length;
    }
}
