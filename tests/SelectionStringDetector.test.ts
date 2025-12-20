import { describe, it, expect } from 'vitest';
import { SelectionStringDetector } from '../src/commands/untranslated/utils/SelectionStringDetector';
import { Range, Position } from 'vscode';
import { MockTextDocument } from './utils/mockTextDocument';

const fullSelection = (doc: MockTextDocument): Range => {
    const lastLineIndex = doc.lineCount - 1;
    const lastLineLength = doc.lineAt(lastLineIndex).text.length;
    return new Range(new Position(0, 0), new Position(lastLineIndex, lastLineLength));
};

const selectSubstring = (doc: MockTextDocument, fragment: string): Range => {
    const text = doc.getText();
    const start = text.indexOf(fragment);
    if (start === -1) {
        throw new Error(`Fragment "${fragment}" not found in mock document`);
    }
    const end = start + fragment.length;
    return new Range(doc.positionAt(start), doc.positionAt(end));
};

describe('SelectionStringDetector', () => {
    it('detects JSX expression strings inside selections', () => {
        const doc = new MockTextDocument('const view = <button>{"Click me"}</button>;', 'typescriptreact');
        const detector = new SelectionStringDetector(doc as any, fullSelection(doc));
        const candidates = detector.findCandidates();

        expect(candidates).toHaveLength(1);
        expect(candidates[0].text).toBe('Click me');
    });

    it('detects object property string values', () => {
        const doc = new MockTextDocument('const meta = { description: `Quick summary here` };', 'typescript');
        const detector = new SelectionStringDetector(doc as any, fullSelection(doc));
        const candidates = detector.findCandidates();

        expect(candidates).toHaveLength(1);
        expect(candidates[0].text).toBe('Quick summary here');
    });

    it('falls back to entire selection for plain text', () => {
        const doc = new MockTextDocument('Welcome aboard teammate', 'plaintext');
        const detector = new SelectionStringDetector(doc as any, fullSelection(doc));
        const candidates = detector.findCandidates();

        expect(candidates).toHaveLength(1);
        expect(candidates[0].text).toBe('Welcome aboard teammate');
    });

    it('detects Blade array value strings', () => {
        const doc = new MockTextDocument(`'greeting' => 'Hello there'`, 'blade', 'view.blade.php');
        const detector = new SelectionStringDetector(doc as any, fullSelection(doc));
        const candidates = detector.findCandidates();

        expect(candidates).toHaveLength(1);
        expect(candidates[0].text).toBe('Hello there');
    });
});
