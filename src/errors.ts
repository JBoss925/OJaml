export class OJamlError extends Error {
  constructor(
    message: string,
    readonly start?: number,
    readonly end?: number,
  ) {
    super(message);
    this.name = "OJamlError";
  }
}

export function formatOJamlError(source: string, error: unknown): string {
  if (!(error instanceof OJamlError) || error.start === undefined) {
    return error instanceof Error ? error.message : String(error);
  }

  const prefix = source.slice(0, error.start);
  const line = prefix.split("\n").length;
  const lineStart = prefix.lastIndexOf("\n") + 1;
  const lineEndRaw = source.indexOf("\n", error.start);
  const lineEnd = lineEndRaw === -1 ? source.length : lineEndRaw;
  const column = error.start - lineStart + 1;
  const lineText = source.slice(lineStart, lineEnd);
  const width = Math.max(1, (error.end ?? error.start + 1) - error.start);
  return `${error.message} at ${line}:${column}\n${lineText}\n${" ".repeat(column - 1)}${"^".repeat(width)}`;
}
