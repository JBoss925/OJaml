import type { Monaco } from "@monaco-editor/react";
import type { editor, languages, Position } from "monaco-editor";
import { check, getStdlibSignatures } from "./check";
import { OJamlError } from "./errors";
import { lex, type Token } from "./lexer";
import { parse } from "./parser";

export const ojamlLanguageId = "ojaml";
export const markerOwner = "ojaml-language-service";

let providersRegistered = false;

const keywords = ["let", "rec", "in", "if", "then", "else", "true", "false", "fun", "match", "with", "mod", "type", "of", "open"];
const stdlibCompletions = getStdlibSignatures();

export function configureOJamlMonaco(monaco: Monaco): void {
  if (!monaco.languages.getLanguages().some((language: { id: string }) => language.id === ojamlLanguageId)) {
    monaco.languages.register({
      id: ojamlLanguageId,
      extensions: [".oj", ".ojaml"],
      aliases: ["OJaml", "ojaml"],
    });
  }

  monaco.languages.setLanguageConfiguration(ojamlLanguageId, {
    comments: {
      blockComment: ["(*", "*)"],
    },
    brackets: [["(", ")"], ["{", "}"]],
    autoClosingPairs: [
      { open: "(", close: ")" },
      { open: "{", close: "}" },
      { open: "(*", close: "*)" },
    ],
    surroundingPairs: [{ open: "(", close: ")" }, { open: "{", close: "}" }],
    indentationRules: {
      increaseIndentPattern: /^\s*(?:let\b.*=\s*|let\s+rec\b.*=\s*|if\b.*\bthen\s*|else\s*|match\b.*\bwith\s*|\|.*->\s*|.*->\s*)$/,
      decreaseIndentPattern: /$^/,
    },
    onEnterRules: [
      {
        beforeText: /^\s*(?:let\b.*=\s*|let\s+rec\b.*=\s*|if\b.*\bthen\s*|else\s*|match\b.*\bwith\s*|\|.*->\s*|.*->\s*)$/,
        action: { indentAction: monaco.languages.IndentAction.Indent },
      },
    ],
  });

  monaco.languages.setMonarchTokensProvider(ojamlLanguageId, {
    defaultToken: "",
    keywords,
    operators: ["+", "-", "*", "/", "**", "=", "<>", "<", "<=", ">", ">=", "&&", "||", "->"],
    tokenizer: {
      root: [
        [/\(\*/, "comment", "@comment"],
        [/"([^"\\]|\\.)*$/, "string.invalid"],
        [/"/, "string", "@string"],
        [/'[a-zA-Z_][a-zA-Z0-9_]*/, "type.identifier"],
        [/[a-zA-Z_][a-zA-Z0-9_'.]*/, { cases: { "@keywords": "keyword", "@default": "identifier" } }],
        [/\d+\.\d+/, "number.float"],
        [/\d+/, "number"],
        [/->|\*\*|<>|<=|>=|&&|\|\||[+\-*/=<>.]/, "operator"],
        [/[(){};:]/, "delimiter"],
        [/\|/, "operator"],
      ],
      comment: [
        [/[^(*)]+/, "comment"],
        [/\(\*/, "comment", "@push"],
        [/\*\)/, "comment", "@pop"],
        [/[(*)]/, "comment"],
      ],
      string: [
        [/[^\\"]+/, "string"],
        [/\\[ntr"\\]/, "string.escape"],
        [/\\./, "string.invalid"],
        [/"/, "string", "@pop"],
      ],
    },
  });

  monaco.editor.defineTheme("ojaml-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "777777" },
      { token: "keyword", foreground: "8ee0ad" },
      { token: "type.identifier", foreground: "b8e6ff" },
      { token: "number", foreground: "f3d084" },
      { token: "operator", foreground: "d8d8d3" },
      { token: "identifier", foreground: "f4f4f2" },
    ],
    colors: {
      "editor.background": "#101010",
      "editor.foreground": "#f4f4f2",
      "editorLineNumber.foreground": "#5f5f5b",
      "editorLineNumber.activeForeground": "#f4f4f2",
      "editor.selectionBackground": "#20382d",
      "editor.inactiveSelectionBackground": "#1a2a22",
      "editorCursor.foreground": "#f7faf6",
      "editorIndentGuide.background1": "#242424",
      "editorIndentGuide.activeBackground1": "#315642",
    },
  });

  monaco.editor.defineTheme("ojaml-light", {
    base: "vs",
    inherit: true,
    rules: [
      { token: "comment", foreground: "66726a" },
      { token: "keyword", foreground: "20382d", fontStyle: "bold" },
      { token: "type.identifier", foreground: "155e75" },
      { token: "number", foreground: "8c5a14" },
      { token: "operator", foreground: "1e2420" },
    ],
    colors: {
      "editor.background": "#fbfdfb",
      "editor.foreground": "#1e2420",
      "editorLineNumber.foreground": "#8a948c",
      "editorLineNumber.activeForeground": "#20382d",
      "editor.selectionBackground": "#cddbd2",
      "editor.inactiveSelectionBackground": "#dde7e0",
      "editorCursor.foreground": "#20382d",
    },
  });

  if (!providersRegistered) {
    registerOJamlProviders(monaco);
    providersRegistered = true;
  }
}

export function getOJamlSyntaxMarkers(source: string, severity: number) {
  try {
    check(parse(source));
    return [];
  } catch (error) {
    if (!(error instanceof OJamlError)) throw error;
    const position = offsetToPosition(source, error.start ?? 0);
    const endPosition = offsetToPosition(source, error.end ?? error.start ?? 0);
    return [{
      severity,
      message: error.message,
      startLineNumber: position.line,
      startColumn: position.column,
      endLineNumber: Math.max(position.line, endPosition.line),
      endColumn: Math.max(position.column + 1, endPosition.column),
    }];
  }
}

function registerOJamlProviders(monaco: Monaco): void {
  monaco.languages.registerCompletionItemProvider(ojamlLanguageId, {
    triggerCharacters: ["."],
    provideCompletionItems(model: editor.ITextModel, position: Position, context: languages.CompletionContext) {
      const word = model.getWordUntilPosition(position);
      const previousColumn = Math.max(1, position.column - 1);
      const previousChar = model.getValueInRange({
        startLineNumber: position.lineNumber,
        startColumn: previousColumn,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      });
      if (word.word.length === 0 && previousChar !== "." && context.triggerKind !== monaco.languages.CompletionTriggerKind.Invoke) {
        return { suggestions: [] };
      }
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      const source = model.getValue();
      const modulePrefix = getCompletionModulePrefix(model, position, word.startColumn);
      const symbols = collectSymbols(source);
      if (modulePrefix) {
        const moduleSuggestions = stdlibCompletions
          .filter((signature) => signature.name.startsWith(`${modulePrefix}.`))
          .map((signature) => {
            const member = signature.name.slice(modulePrefix.length + 1);
            return {
              label: member,
              kind: monaco.languages.CompletionItemKind.Function,
              detail: signature.detail,
              documentation: signature.documentation,
              insertText: member,
              range,
              sortText: member,
            };
          });
        return { suggestions: moduleSuggestions };
      }
      const suggestions: languages.CompletionItem[] = [
        ...keywords.map((keyword) => ({
          label: keyword,
          kind: monaco.languages.CompletionItemKind.Keyword,
          insertText: keyword,
          range,
        })),
        {
          label: "print",
          kind: monaco.languages.CompletionItemKind.Function,
          detail: "print : int|float|string -> unit",
          insertText: "print ${1:value}",
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          documentation: "Prints an integer, float, or string and returns unit.",
          range,
        },
        ...stdlibCompletions.filter((signature) => signature.name !== "print").map((signature) => ({
          label: signature.name,
          kind: monaco.languages.CompletionItemKind.Function,
          detail: signature.detail,
          documentation: signature.documentation,
          insertText: signature.name,
          range,
        })),
        {
          label: "let main",
          kind: monaco.languages.CompletionItemKind.Snippet,
          detail: "Program entry point",
          insertText: "let main =\n  ${1:()}",
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          range,
        },
        {
          label: "match",
          kind: monaco.languages.CompletionItemKind.Snippet,
          detail: "Pattern match",
          insertText: "match ${1:value} with\n| ${2:0} -> ${3:()}\n| _ -> ${4:()}",
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          range,
        },
        {
          label: "if then else",
          kind: monaco.languages.CompletionItemKind.Snippet,
          detail: "Conditional expression",
          insertText: "if ${1:condition} then ${2:value} else ${3:other}",
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          range,
        },
        ...symbols.map((symbol) => ({
          label: symbol.name,
          kind: symbol.kind === "function" ? monaco.languages.CompletionItemKind.Function : monaco.languages.CompletionItemKind.Variable,
          detail: symbol.detail,
          insertText: symbol.name,
          range,
        })),
      ];
      return { suggestions };
    },
  });

  monaco.languages.registerHoverProvider(ojamlLanguageId, {
    provideHover(model: editor.ITextModel, position: Position) {
      const source = model.getValue();
      const symbol = getOJamlHoverInfo(source, model.getOffsetAt(position));
      if (!symbol) return null;
      const start = offsetToPosition(source, symbol.span?.start ?? model.getOffsetAt(position));
      const end = offsetToPosition(source, symbol.span?.end ?? model.getOffsetAt(position) + 1);
      return {
        range: new monaco.Range(start.line, start.column, end.line, end.column),
        contents: [
          { value: "```ocaml\n" + symbol.detail + "\n```" },
          ...(symbol.documentation ? [{ value: symbol.documentation }] : []),
        ],
      };
    },
  });

  monaco.languages.registerSignatureHelpProvider(ojamlLanguageId, {
    signatureHelpTriggerCharacters: [" ", "("],
    provideSignatureHelp(model: editor.ITextModel, position: Position) {
      const prefix = model.getValueInRange({
        startLineNumber: position.lineNumber,
        startColumn: Math.max(1, position.column - 24),
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      });
      const call = prefix.match(/\b(print|println)\s+(?:[^ \n\t(]*|\()$/);
      if (!call) return null;
      const name = call[1];
      return {
        value: {
          activeParameter: 0,
          activeSignature: 0,
          signatures: [{
            label: `${name} value`,
            documentation: name === "println"
              ? "Prints an int, float, or string followed by a newline and returns unit."
              : "Prints an int, float, or string and returns unit.",
            parameters: [{ label: "value: int | float | string" }],
          }],
        },
        dispose() {},
      };
    },
  });
}

function getCompletionModulePrefix(model: editor.ITextModel, position: Position, wordStartColumn: number): "Array" | "Float" | "List" | "Map" | "Set" | "String" | undefined {
  const linePrefix = model.getValueInRange({
    startLineNumber: position.lineNumber,
    startColumn: 1,
    endLineNumber: position.lineNumber,
    endColumn: wordStartColumn,
  });
  const match = /(?:^|[^A-Za-z0-9_'.])(Array|Float|List|Map|Set|String)\.$/.exec(linePrefix);
  return match?.[1] as "Array" | "Float" | "List" | "Map" | "Set" | "String" | undefined;
}

type SymbolInfo = {
  name: string;
  kind: "function" | "value" | "builtin" | "keyword" | "literal" | "operator" | "delimiter";
  detail: string;
  documentation?: string;
  span?: { start: number; end: number };
};

function collectSymbols(source: string): SymbolInfo[] {
  try {
    const checked = check(parse(source));
    return checked.symbols.map((symbol) => ({
      name: symbol.name,
      kind: symbol.kind,
      detail: symbol.detail,
      documentation: symbol.kind === "builtin" ? "OJaml standard library builtin." : undefined,
      span: symbol.span,
    }));
  } catch {
    return fallbackBuiltins();
  }
}

export function getOJamlHoverInfo(source: string, offset: number): SymbolInfo | undefined {
  try {
    const checked = check(parse(source));
    const token = checked.tokens.find((item) => offset >= item.span.start && offset < item.span.end);
    if (token) return token;
  } catch {
    const fallback = findLexicalHover(source, offset);
    if (fallback) return fallback;
    return fallbackBuiltins().find((symbol) => symbol.span && offset >= symbol.span.start && offset < symbol.span.end);
  }
  return findLexicalHover(source, offset);
}

function fallbackBuiltins(): SymbolInfo[] {
  return stdlibCompletions.map((signature) => ({
    name: signature.name,
    kind: "builtin" as const,
    detail: signature.detail,
    documentation: signature.documentation,
  }));
}

function findLexicalHover(source: string, offset: number): SymbolInfo | undefined {
  const token = lex(source).find((item) => item.kind !== "eof" && offset >= item.start && offset < item.end);
  if (!token) return undefined;
  return lexicalHover(token);
}

function lexicalHover(token: Token): SymbolInfo | undefined {
  if (token.kind === "keyword") return { name: token.text, kind: "keyword", detail: `${token.text} keyword`, span: token };
  if (token.kind === "int") return { name: token.text, kind: "literal", detail: `${token.text} : int`, span: token };
  if (token.kind === "string") return { name: "string literal", kind: "literal", detail: "string literal : string", span: token };
  if (token.kind === "typevar") return { name: token.text, kind: "value", detail: `${token.text} type parameter`, span: token };
  if (token.kind === "operator" || token.kind === "equals" || token.kind === "arrow" || token.kind === "pipe") {
    return { name: token.text, kind: "operator", detail: `${token.text} operator`, span: token };
  }
  if (token.kind === "lparen" || token.kind === "rparen") {
    return { name: token.text, kind: "delimiter", detail: `${token.text} delimiter`, span: token };
  }
  if (token.kind === "semicolon2") return { name: token.text, kind: "delimiter", detail: ";; declaration separator", span: token };
  if (token.kind === "ident") return { name: token.text, kind: "value", detail: `${token.text} identifier`, span: token };
  return undefined;
}

function offsetToPosition(source: string, offset: number): { line: number; column: number } {
  const prefix = source.slice(0, offset);
  const parts = prefix.split("\n");
  return { line: parts.length, column: parts[parts.length - 1].length + 1 };
}
