export interface ExtractedItem {
    type: string;
    text: string;
    kind?: string;
    parentTag?: string;
}

export interface ParseResult {
    items: ExtractedItem[];
    stats: {
        extracted: number;
        errors: number;
    };
}

export interface Parser {
    parse(content: string): ParseResult;
}

export function getParserForFile(filePath: string): Parser | null;
export function getAllParsers(): Parser[];
export function getParserByName(name: string): Parser | null;
export function getSupportedExtensions(): string[];
export function isSupported(filePath: string): boolean;
export function parseFile(filePath: string): ParseResult | null;
export function registerParser(parser: Parser): void;
export function getFrameworkInfo(filePath: string): any;
