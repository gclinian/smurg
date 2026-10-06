// File paths in rendered text (DESIGN §5.5: "a path that resolves in the session's root is a link that opens the
// file"). The renderer knows nothing about sessions, roots or the file tree: whoever renders text hands it this
// adapter (the conversation column builds one from the session's root and the existing path-links logic).

/** A path-looking piece of one run of text: `[start, end)` in UTF-16 units of that run. */
export interface PathMatch {
  readonly start: number;
  readonly end: number;
  /** The piece as written, with a `:line[:column]` suffix when there is one. */
  readonly text: string;
}

/** What a resolved path does when it is activated. */
export interface PathTarget {
  /** The path inside its root, for the accessible name ("Open src/cart/total.ts"). */
  readonly label: string;
  open(): void;
}

export interface MarkdownPaths {
  /** The candidates of a run of text, in order and not overlapping. Synchronous and cheap: it runs while rendering. */
  find(text: string): readonly PathMatch[];
  /** What the candidate opens, or null when it is not a file the viewer can open. Never rejects. */
  resolve(match: PathMatch): Promise<PathTarget | null>;
}
