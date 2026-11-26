// SPDX-License-Identifier: AGPL-3.0-or-later
// The CSS filter for message bodies: style sheets and style attributes go
// through css-tree and keep a safe subset.
// - No at-rule but @media; inside it, only rules.
// - No behavior, -moz-binding, expression() or position:fixed, and no
//   custom properties.
// - An image `url()` or `image-set()` candidate (in the background,
//   border-image and list-style properties) becomes the view's id for it;
//   a declaration with any other URL goes.
// - A declaration or rule with a backslash escape in its source, or that
//   css-tree could only parse as raw text, goes. css-tree decodes escapes, so
//   the source is checked, not the generated text.
// The result is parsed again and checked, and must not contain `</`, which
// would end a <style> element; if the check fails, nothing is kept.

import type * as csstree from 'css-tree';
import generate from 'css-tree/generator';
import parse from 'css-tree/parser';
import walk from 'css-tree/walker';

/** Turns URLs into the view's id URLs. */
export interface UrlRewriter {
  /** True if `url` would get an id; hands none out. */
  accepts(url: string): boolean;
  /** The id URL for `url`, or null if it must go. */
  rewrite(url: string): string | null;
}

/** Properties whose URLs are images, which become ids. */
export const IMAGE_PROPERTIES: ReadonlySet<string> = new Set([
  'background',
  'background-image',
  'border-image',
  'border-image-source',
  'list-style',
  'list-style-image',
]);
const FORBIDDEN_PROPERTIES = new Set(['behavior', '-ms-behavior', '-moz-binding']);
const FORBIDDEN_FUNCTIONS = new Set([
  'expression',
  'src',
  'element',
  'paint',
  'var',
  'env',
  'attr',
]);
const IMAGE_SET_FUNCTIONS = new Set(['image-set', '-webkit-image-set']);
const ID_URL_RE = /^mail-asset:\/\/v\/[0-9a-f]{32}\/[rc]\d{1,6}$/;
const URL_LIKE_RE = /^\s*(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

type Node = csstree.CssNode;

/** True if the node's source text has a backslash escape, or its source is unknown. */
function escaped(node: Node, text: string): boolean {
  if (!node.loc) return true;
  return text.slice(node.loc.start.offset, node.loc.end.offset).includes('\\');
}

function hasRaw(node: Node): boolean {
  let raw = false;
  walk(node, (n) => {
    if (n.type === 'Raw') raw = true;
  });
  return raw;
}

/** The URLs in a value that become ids: `url()` values and image-set() strings. */
function valueUrls(
  value: Node,
): Array<csstree.Url | { set: csstree.List<Node>; item: csstree.ListItem<Node>; value: string }> {
  const found: Array<
    csstree.Url | { set: csstree.List<Node>; item: csstree.ListItem<Node>; value: string }
  > = [];
  walk(value, (node) => {
    if (node.type === 'Url') found.push(node);
    if (node.type === 'Function' && IMAGE_SET_FUNCTIONS.has(node.name.toLowerCase())) {
      node.children.forEach((child, item) => {
        if (child.type === 'String') found.push({ set: node.children, item, value: child.value });
      });
    }
  });
  return found;
}

/** True if a declaration may stay: nothing forbidden, and every URL in it can become an id. */
function acceptable(decl: csstree.Declaration, urls: UrlRewriter, text: string): boolean {
  const property = decl.property.toLowerCase();
  if (property.startsWith('--') || FORBIDDEN_PROPERTIES.has(property)) return false;
  if (decl.value.type === 'Raw' || hasRaw(decl.value)) return false;
  if (escaped(decl, text)) return false;
  let ok = true;
  walk(decl.value, (node) => {
    if (
      node.type === 'Identifier' &&
      property === 'position' &&
      node.name.toLowerCase() === 'fixed'
    )
      ok = false;
    if (node.type === 'Function') {
      const name = node.name.toLowerCase();
      if (FORBIDDEN_FUNCTIONS.has(name)) ok = false;
      if (IMAGE_SET_FUNCTIONS.has(name) && !IMAGE_PROPERTIES.has(property)) ok = false;
    }
    if (node.type === 'Url' && !IMAGE_PROPERTIES.has(property)) ok = false;
  });
  if (!ok) return false;
  const inSets = new Set<string>();
  for (const url of valueUrls(decl.value)) {
    if (!urls.accepts(url.value)) return false;
    if (!('type' in url)) inSets.add(url.value);
  }
  // A string that reads like a URL is allowed only as an image-set() candidate.
  let stray = false;
  walk(decl.value, (node) => {
    if (node.type === 'String' && URL_LIKE_RE.test(node.value) && !inSets.has(node.value))
      stray = true;
  });
  return !stray;
}

/** Filters one declaration: false if it must go; otherwise its URLs become ids. */
function keepDeclaration(decl: csstree.Declaration, urls: UrlRewriter, text: string): boolean {
  if (!acceptable(decl, urls, text)) return false;
  for (const url of valueUrls(decl.value)) {
    const id = urls.rewrite(url.value);
    if (id === null) return false;
    if ('type' in url) url.value = id;
    else url.item.data = { type: 'Url', value: id } as csstree.Url;
  }
  return true;
}

function filterBlock(block: csstree.Block, urls: UrlRewriter, text: string): void {
  block.children.forEach((node, item, list) => {
    if (node.type !== 'Declaration' || !keepDeclaration(node, urls, text)) list.remove(item);
  });
}

/** Filters the rules of a style sheet or an @media block in place. */
function filterRules(
  children: csstree.List<Node>,
  urls: UrlRewriter,
  text: string,
  nested: boolean,
): void {
  children.forEach((node, item, list) => {
    if (node.type === 'Rule') {
      if (node.prelude.type === 'Raw' || hasRaw(node.prelude) || escaped(node.prelude, text)) {
        list.remove(item);
        return;
      }
      filterBlock(node.block, urls, text);
      if (node.block.children.isEmpty) list.remove(item);
      return;
    }
    if (node.type === 'Atrule' && !nested && node.name.toLowerCase() === 'media' && node.block) {
      if (
        node.prelude &&
        (node.prelude.type === 'Raw' || hasRaw(node.prelude) || escaped(node.prelude, text))
      ) {
        list.remove(item);
        return;
      }
      filterRules(node.block.children, urls, text, true);
      if (node.block.children.isEmpty) list.remove(item);
      return;
    }
    list.remove(item);
  });
}

/** Problems in filtered CSS: anything the filter should have removed. Empty when it is clean. */
export function cssProblems(css: string, context: 'stylesheet' | 'declarationList'): string[] {
  const found: string[] = [];
  if (css.includes('\\')) found.push('escape');
  if (css.includes('</')) found.push('end tag');
  const ast = parse(css, { context, onParseError: () => found.push('parse error') });
  walk(ast, (node) => {
    if (node.type === 'Raw') found.push('raw');
    if (node.type === 'Atrule' && node.name.toLowerCase() !== 'media') found.push(`@${node.name}`);
    if (node.type === 'Url' && !ID_URL_RE.test(node.value)) found.push(`url(${node.value})`);
    if (node.type !== 'Declaration') return;
    const property = node.property.toLowerCase();
    if (property.startsWith('--') || FORBIDDEN_PROPERTIES.has(property)) found.push(property);
    walk(node.value, (value) => {
      if (property === 'position' && value.type === 'Identifier' && /^fixed$/i.test(value.name))
        found.push('position:fixed');
      if (value.type === 'Function' && FORBIDDEN_FUNCTIONS.has(value.name.toLowerCase()))
        found.push(`${value.name}()`);
      if (value.type === 'String' && URL_LIKE_RE.test(value.value)) found.push(`"${value.value}"`);
    });
  });
  return found;
}

function finish(ast: Node, context: 'stylesheet' | 'declarationList'): string {
  const css = generate(ast);
  // Belt and braces: what goes out must parse back clean.
  return cssProblems(css, context).length === 0 ? css : '';
}

/** A style sheet's filtered text, or '' if nothing is left. */
export function filterStyleSheet(text: string, urls: UrlRewriter): string {
  const ast = parse(text, {
    context: 'stylesheet',
    parseCustomProperty: false,
    positions: true,
  });
  if (ast.type !== 'StyleSheet') return '';
  filterRules(ast.children, urls, text, false);
  return ast.children.isEmpty ? '' : finish(ast, 'stylesheet');
}

/** A style attribute's filtered declarations, or '' if none is left. */
export function filterStyleAttribute(text: string, urls: UrlRewriter): string {
  const ast = parse(text, {
    context: 'declarationList',
    parseCustomProperty: false,
    positions: true,
  });
  if (ast.type !== 'DeclarationList') return '';
  ast.children.forEach((node, item, list) => {
    if (node.type !== 'Declaration' || !keepDeclaration(node, urls, text)) list.remove(item);
  });
  return ast.children.isEmpty ? '' : finish(ast, 'declarationList');
}
