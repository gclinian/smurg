// The Markdown renderer (DESIGN §5.5), shared by the conversation column, the spec's Read view and a report's
// sections: import it from here.
export {
  MAX_PATH_LOOKUPS,
  Markdown,
  MarkdownPieces,
  PlainText,
  StreamingMarkdown,
  STREAM_PARSE_MS,
  parseMarkdown,
  type MarkdownOptions,
  type MarkdownPiecesProps,
  type MarkdownProps,
  type PlainTextProps,
  type StreamingMarkdownProps,
} from './Markdown.tsx';
export { findMentions } from './render.tsx';
export { LINK_PROTOCOLS, safeHref } from './links.ts';
export type { MarkdownPaths, PathMatch, PathTarget } from './paths.ts';
