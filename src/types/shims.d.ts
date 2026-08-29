declare module 'markdown-it-footnote' {
  import type MarkdownIt from 'markdown-it';
  const plugin: (md: MarkdownIt, ...args: any[]) => void;
  export default plugin;
}
declare module 'markdown-it-deflist' {
  import type MarkdownIt from 'markdown-it';
  const plugin: (md: MarkdownIt, ...args: any[]) => void;
  export default plugin;
}
declare module 'markdown-it-task-lists' {
  import type MarkdownIt from 'markdown-it';
  const plugin: (md: MarkdownIt, opts?: Record<string, unknown>) => void;
  export default plugin;
}
