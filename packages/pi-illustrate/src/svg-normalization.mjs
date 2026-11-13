import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { checkGeometry, LIMITS } from "./render-limits.mjs";
import {
  bakeCss,
  cssReferences,
  declarations,
  localReference,
  PRESENTATION,
  stylesheet,
  variableNames,
} from "./svg-css.mjs";

const SVG = "http://www.w3.org/2000/svg";
const XLINK = "http://www.w3.org/1999/xlink";
const XML = "http://www.w3.org/XML/1998/namespace";
const XMLNS = "http://www.w3.org/2000/xmlns/";
const ELEMENTS = new Set(
  (
    "svg g defs symbol use path rect circle ellipse line polyline polygon text tspan textPath title desc style " +
    "linearGradient radialGradient stop marker clipPath mask pattern"
  ).split(" "),
);
const ATTRIBUTES = new Set(
  (
    "id class style width height viewBox preserveAspectRatio x y x1 x2 y1 y2 dx dy cx cy r rx ry " +
    "d points transform pathLength rotate textLength lengthAdjust startOffset method spacing " +
    "gradientUnits gradientTransform spreadMethod fx fy fr offset markerWidth markerHeight refX refY orient markerUnits " +
    "clipPathUnits maskUnits maskContentUnits patternUnits patternContentUnits patternTransform version role type"
  ).split(" "),
);

/** Explicit palettes include Pele's contrast inks and all eight chart series. Source declarations still take precedence. */
export const PALETTES = Object.freeze({
  light: Object.freeze({
    "--pele-bg": "#ffffff",
    "--pele-fg": "#1f1f1f",
    "--pele-muted": "#616161",
    "--pele-line": "#333333",
    "--pele-surface": "#f3f3f3",
    "--pele-surface-alt": "#e6e6e6",
    "--pele-border": "#858585",
    "--pele-accent": "#4169b1",
    "--pele-critical": "#c93636",
    "--pele-fg-on-light": "#1f1f1f",
    "--pele-fg-on-dark": "#ffffff",
    "--pele-series-1": "#4c78a8",
    "--pele-series-2": "#f58518",
    "--pele-series-3": "#54a24b",
    "--pele-series-4": "#e45756",
    "--pele-series-5": "#72b7b2",
    "--pele-series-6": "#eeca3b",
    "--pele-series-7": "#b279a2",
    "--pele-series-8": "#9d755d",
  }),
  dark: Object.freeze({
    "--pele-bg": "#181a1f",
    "--pele-fg": "#eeeeee",
    "--pele-muted": "#b5b8c0",
    "--pele-line": "#c9ced8",
    "--pele-surface": "#292d36",
    "--pele-surface-alt": "#373d48",
    "--pele-border": "#858d9e",
    "--pele-accent": "#90b4f4",
    "--pele-critical": "#ff8585",
    "--pele-fg-on-light": "#1f1f1f",
    "--pele-fg-on-dark": "#ffffff",
    "--pele-series-1": "#83b3e6",
    "--pele-series-2": "#ffae65",
    "--pele-series-3": "#86ca7e",
    "--pele-series-4": "#ff8c8b",
    "--pele-series-5": "#92d7d1",
    "--pele-series-6": "#f4da76",
    "--pele-series-7": "#d5a6dd",
    "--pele-series-8": "#cfaa94",
  }),
});

/** @typedef {import('@xmldom/xmldom').Element} Element */
/** @param {string} source */
function parseXml(source) {
  if (Buffer.byteLength(source) > LIMITS.svgBytes) throw new Error("SVG exceeds the 4 MiB limit.");
  // XML declarations cannot define entities; DTDs can. Reject DTD/entity syntax before parsing.
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(source)) throw new Error("SVG DTDs and entities are not supported.");
  try {
    return new DOMParser({
      onError() {
        throw new Error("Malformed SVG XML.");
      },
    }).parseFromString(source, "image/svg+xml");
  } catch {
    throw new Error("Malformed SVG XML.");
  }
}

/** @param {string|null} text @returns {number|undefined} */
function dimension(text) {
  if (text === null || text === "") return undefined;
  const match = /^\s*([+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(px|pt|pc|mm|cm|in)?\s*$/i.exec(text);
  if (!match) throw new Error("Unsupported SVG dimensions; use absolute lengths or a viewBox.");
  const units = /** @type {Record<string,number>} */ ({
    px: 1,
    pt: 96 / 72,
    pc: 16,
    mm: 96 / 25.4,
    cm: 96 / 2.54,
    in: 96,
  });
  return Number(match[1]) * (units[match[2]?.toLowerCase() ?? "px"] ?? 1);
}

/** Bound reference expansion as well as XML nesting, including use/gradient/marker cycles.
 * @param {Element[]} elements @param {Element} root
 */
function checkReferences(elements, root) {
  const byId = new Map(elements.map((element) => [element.getAttribute("id"), element]));
  /** @type {Map<Element,Element[]>} */
  const graph = new Map();
  let count = 0;
  for (const element of elements) {
    const links = /** @type {Element[]} */ (Array.from(element.childNodes).filter((node) => node.nodeType === 1));
    for (const attribute of Array.from(element.attributes)) {
      const refs =
        attribute.localName === "href"
          ? [localReference(attribute.value)]
          : PRESENTATION.has(attribute.name)
            ? cssReferences(attribute.value)
            : [];
      for (const ref of refs) {
        const target = byId.get(ref);
        if (!target) throw new Error("Missing SVG reference target.");
        links.push(target);
        if (++count > LIMITS.maxEdges) throw new Error("SVG reference limit exceeded.");
      }
    }
    graph.set(element, links);
  }
  let expanded = 0;
  const visiting = new Set();
  /** @param {Element} element @param {number} depth */
  function visit(element, depth) {
    if (visiting.has(element)) throw new Error("Cyclic SVG reference.");
    if (depth > LIMITS.depth || ++expanded > LIMITS.elements)
      throw new Error("SVG reference expansion limit exceeded.");
    visiting.add(element);
    for (const child of graph.get(element) ?? []) visit(child, depth + 1);
    visiting.delete(element);
  }
  visit(root, 0);
}

/** Validate the bounded static subset. No image, font, resolver, network, or source-specified file access is permitted.
 * @param {string} source @param {'svg'|'mermaid'} kind @param {'dark'|'light'} [appearance]
 * @returns {{svg:string,width:number,height:number,kind:'svg'|'mermaid'}}
 */
export function normalizeSvg(source, kind, appearance) {
  const document = parseXml(source);
  const root = document.documentElement;
  if (root?.tagName !== "svg" || (root.namespaceURI && root.namespaceURI !== SVG))
    throw new Error("Expected one SVG root element.");
  /** @type {Element[]} */
  const elements = [];
  /** @type {import('./svg-css.mjs').Rule[]} */
  const rules = [];
  const ids = new Set();
  /** @type {string[]} */
  const references = [];
  /** @type {Element[]} */
  const styles = [];
  let hasVariables = false;
  let hasUse = false;
  const stack = [{ node: /** @type {import('@xmldom/xmldom').Node} */ (document), depth: 0 }];
  while (stack.length) {
    const item = stack.pop();
    if (!item) break;
    const { node, depth } = item;
    if (depth > LIMITS.depth) throw new Error("SVG nesting limit exceeded.");
    if (node.nodeType === 10 || node.nodeType === 5) throw new Error("SVG DTDs and entities are not supported.");
    if (node.nodeType === 7 && (node.nodeName !== "xml" || node.parentNode !== document))
      throw new Error("SVG processing instructions are not supported.");
    if (node.nodeType === 1) {
      const element = /** @type {Element} */ (node);
      if (!ELEMENTS.has(element.tagName) || element.prefix || (element.namespaceURI && element.namespaceURI !== SVG))
        throw new Error("Unsupported SVG element or namespace.");
      elements.push(element);
      if (element.tagName === "use") hasUse = true;
      if (elements.length > LIMITS.elements) throw new Error("SVG element limit exceeded.");
      const id = element.getAttribute("id");
      if (id) {
        if (ids.has(id)) throw new Error("Duplicate SVG id.");
        ids.add(id);
      }
      for (const attribute of Array.from(element.attributes)) {
        const name = attribute.localName ?? attribute.name;
        const namespace = attribute.namespaceURI;
        if (namespace === XMLNS || attribute.name === "xmlns") {
          if (
            !(
              (attribute.name === "xmlns" && attribute.value === SVG) ||
              (attribute.name === "xmlns:xlink" && attribute.value === XLINK)
            )
          )
            throw new Error("Unsupported SVG namespace declaration.");
        } else if (namespace === XML) {
          if (attribute.name !== "xml:space" || !["preserve", "default"].includes(attribute.value))
            throw new Error("Unsupported SVG XML attribute.");
        } else if (name.toLowerCase() === "href") {
          if (
            name !== "href" ||
            (namespace && namespace !== XLINK) ||
            !["use", "linearGradient", "radialGradient", "pattern", "textPath"].includes(element.tagName)
          )
            throw new Error("Unsupported SVG href.");
          references.push(localReference(attribute.value));
        } else if (namespace || attribute.prefix) throw new Error("Unsupported SVG attribute namespace.");
        else if (name.toLowerCase().startsWith("on")) throw new Error("SVG event handlers are not supported.");
        else if (PRESENTATION.has(name) || name === "style") {
          const values = declarations(name === "style" ? attribute.value : `${name}:${attribute.value}`);
          if (values.some((value) => variableNames(value.value).size > 0)) hasVariables = true;
        } else if (!ATTRIBUTES.has(name) && !name.startsWith("aria-") && !name.startsWith("data-"))
          throw new Error(`Unsupported SVG attribute: ${name}`);
      }
      if (element.tagName === "style") {
        if (element.getAttribute("type") && element.getAttribute("type") !== "text/css")
          throw new Error("Unsupported SVG style type.");
        const sheet = stylesheet(element.textContent ?? "");
        if (sheet.some((rule) => rule.declarations.some((value) => variableNames(value.value).size > 0)))
          hasVariables = true;
        rules.push(...sheet);
        styles.push(element);
        if (rules.length > LIMITS.cssRules) throw new Error("SVG CSS rule limit exceeded.");
      }
    }
    // Reverse push preserves document order for the cascade and inheritance pass.
    for (let child = node.lastChild; child; child = child.previousSibling)
      stack.push({ node: child, depth: depth + 1 });
  }
  if (Array.from(document.childNodes).filter((node) => node.nodeType === 1).length !== 1)
    throw new Error("Expected one SVG root element.");
  for (const reference of references) if (!ids.has(reference)) throw new Error("Missing SVG reference target.");
  // CSS variables in a <use> shadow tree inherit from each instance, not the source defs scope.
  // Reject this combination instead of baking the wrong instance-dependent value into shared defs.
  if (hasUse && hasVariables) throw new Error("CSS variables with SVG use instances are not supported.");
  const viewBox = root.getAttribute("viewBox");
  let box;
  if (viewBox) {
    box = viewBox
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    if (box.length !== 4 || box.some((n) => !Number.isFinite(n)) || box.some((n) => Math.abs(n) > LIMITS.dimension))
      throw new Error("Invalid SVG viewBox.");
    checkGeometry(box[2], box[3]);
  }
  let width = dimension(root.getAttribute("width"));
  let height = dimension(root.getAttribute("height"));
  if (box) {
    if (width === undefined && height !== undefined) width = (height * box[2]) / box[3];
    if (height === undefined && width !== undefined) height = (width * box[3]) / box[2];
    width ??= box[2];
    height ??= box[3];
  }
  if (width === undefined || height === undefined) throw new Error("SVG needs dimensions or a viewBox.");
  checkGeometry(width, height);
  root.setAttribute("xmlns", SVG);
  root.setAttribute("width", String(width));
  root.setAttribute("height", String(height));
  if (!box) root.setAttribute("viewBox", `0 0 ${width} ${height}`);
  const serializer = new XMLSerializer();
  const neutral = serializer.serializeToString(document);
  // Always validate CSS semantics. Layout retains the neutral variables; raster publishes only baked attributes.
  bakeCss(elements, rules, kind === "mermaid" ? PALETTES[appearance ?? "light"] : {}, ids);
  for (const style of styles) style.parentNode?.removeChild(style);
  checkReferences(elements, root);
  const svg = appearance === undefined ? neutral : serializer.serializeToString(document);
  if (Buffer.byteLength(svg) > LIMITS.svgBytes) throw new Error("Normalized SVG exceeds the 4 MiB limit.");
  return { svg, width, height, kind };
}
