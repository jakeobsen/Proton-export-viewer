// SPDX-License-Identifier: AGPL-3.0-or-later
// Types for the css-tree entry points the CSS filter imports: the parser,
// walker and generator alone. The main entry also builds the lexer, which
// loads its data from JSON files at run time, and those files are not in the
// bundle.

declare module 'css-tree/parser' {
  const parse: typeof import('css-tree').parse;
  export default parse;
}

declare module 'css-tree/walker' {
  const walk: typeof import('css-tree').walk;
  export default walk;
}

declare module 'css-tree/generator' {
  const generate: typeof import('css-tree').generate;
  export default generate;
}
