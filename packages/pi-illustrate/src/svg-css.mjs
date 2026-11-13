import * as css from "css-tree";
import { LIMITS } from "./render-limits.mjs";

/** @typedef {import('@xmldom/xmldom').Element} Element */
/** @typedef {import('css-tree').CssNode} CssNode */
/** @typedef {{property:string,value:string,important:boolean}} Declaration */
/** @typedef {{test:(element:Element)=>boolean,specificity:number,declarations:Declaration[]}} Rule */

export const PRESENTATION = new Set(
  (
    "color fill fill-opacity fill-rule stroke stroke-width stroke-opacity stroke-dasharray stroke-dashoffset " +
    "stroke-linecap stroke-linejoin stroke-miterlimit opacity font-family font-size font-style font-weight " +
    "font-variant font-stretch text-anchor text-decoration letter-spacing word-spacing baseline-shift " +
    "dominant-baseline alignment-baseline clip-path clip-rule mask marker-start marker-mid marker-end " +
    "stop-color stop-opacity flood-color flood-opacity display visibility overflow paint-order vector-effect rx ry"
  ).split(" "),
);
const PROPERTIES = new Set([...PRESENTATION, "font", "text-transform", "direction"]);

/** Parse strictly: css-tree's recovery nodes must not hide unsupported syntax. @param {string} text @param {'value'|'stylesheet'|'declarationList'|'selectorList'} context */
function parse(text, context) {
  return css.parse(text, {
    context,
    parseCustomProperty: true,
    onParseError() {
      throw new Error("Invalid SVG CSS.");
    },
  });
}

/** @param {string} text @returns {Declaration[]} */
export function declarations(text) {
  const ast = parse(text, "declarationList");
  if (ast.type !== "DeclarationList") throw new Error("Invalid SVG declarations.");
  return ast.children.toArray().map((node) => {
    if (node.type !== "Declaration") throw new Error("Unsupported SVG CSS declaration.");
    const property = css.ident.decode(node.property);
    if (!property.startsWith("--") && !PROPERTIES.has(property))
      throw new Error(`Unsupported SVG CSS property: ${property}`);
    const value = css.generate(node.value);
    inspectValue(parse(value, "value"));
    return { property, value, important: Boolean(node.important) };
  });
}

/** @param {CssNode} ast */
function inspectValue(ast) {
  css.walk(ast, (node) => {
    if (node.type === "Url") localReference(node.value);
    else if (node.type === "Raw") {
      // css-tree stores var() fallback tokens as Raw. Reparse them, including nested fallbacks.
      inspectValue(parse(node.value, "value"));
    } else if (node.type === "Function") {
      const name = css.ident.decode(node.name).toLowerCase();
      if (!["var", "rgb", "rgba", "hsl", "hsla", "color-mix", "min", "max"].includes(name)) {
        throw new Error(`Unsupported SVG CSS function: ${name}`);
      }
    }
  });
}

/** @param {string} value */
export function localReference(value) {
  if (!/^#[A-Za-z_][\w.:-]*$/.test(value)) throw new Error("Only same-document SVG references are supported.");
  return value.slice(1);
}

/** @param {string} value @returns {string[]} */
export function cssReferences(value) {
  const references = /** @type {string[]} */ ([]);
  css.walk(parse(value, "value"), (node) => {
    if (node.type === "Url") references.push(localReference(node.value));
  });
  return references;
}

/** @param {CssNode} selector @returns {{test:(element:Element)=>boolean,specificity:number}} */
function compileSelector(selector) {
  if (selector.type !== "Selector") throw new Error("Unsupported SVG selector.");
  /** @type {((element:Element)=>boolean)[][]} */
  const groups = [[]];
  /** @type {string[]} */
  const combinators = [];
  let specificity = 0;
  const weights = { ids: 0, classes: 0, types: 0 };
  for (const part of selector.children) {
    if (part.type === "Combinator") {
      if (![" ", ">", "+", "~"].includes(part.name) || !groups.at(-1)?.length)
        throw new Error("Unsupported SVG combinator.");
      combinators.push(part.name);
      groups.push([]);
    } else if (part.type === "TypeSelector") {
      const name = css.ident.decode(part.name);
      if (name !== "*" && !/^[A-Za-z]+$/.test(name)) throw new Error("Unsupported SVG type selector.");
      groups.at(-1)?.push((element) => name === "*" || element.tagName === name);
      if (name !== "*") {
        specificity += 1;
        weights.types++;
      }
    } else if (part.type === "ClassSelector") {
      const name = css.ident.decode(part.name);
      groups.at(-1)?.push((element) => (element.getAttribute("class") ?? "").split(/\s+/).includes(name));
      specificity += 100;
      weights.classes++;
    } else if (part.type === "IdSelector") {
      const name = css.ident.decode(part.name);
      groups.at(-1)?.push((element) => element.getAttribute("id") === name);
      specificity += 10_000;
      weights.ids++;
    } else if (part.type === "PseudoClassSelector" && part.name === "root" && part.children === null) {
      groups.at(-1)?.push((element) => element.parentNode?.nodeType === 9);
      specificity += 100;
      weights.classes++;
    } else throw new Error("Unsupported SVG CSS selector.");
  }
  if (!groups.at(-1)?.length) throw new Error("Invalid SVG selector.");
  // Base-100 weights are exact only while every column stays below 100.
  if (Object.values(weights).some((count) => count >= 100)) throw new Error("SVG selector specificity limit exceeded.");
  /** @param {Element} element @param {number} index @returns {boolean} */
  function matches(element, index) {
    if (!groups[index].every((test) => test(element))) return false;
    if (index === 0) return true;
    const combinator = combinators[index - 1];
    let node = combinator === "+" || combinator === "~" ? element.previousSibling : element.parentNode;
    while (node) {
      if (node.nodeType === 1) {
        if (matches(/** @type {Element} */ (node), index - 1)) return true;
        if (combinator === ">" || combinator === "+") return false;
      }
      node = combinator === "+" || combinator === "~" ? node.previousSibling : node.parentNode;
    }
    return false;
  }
  return { test: (element) => matches(element, groups.length - 1), specificity };
}

/** @param {string} text @returns {Rule[]} */
export function stylesheet(text) {
  const ast = parse(text, "stylesheet");
  if (ast.type !== "StyleSheet") throw new Error("Invalid SVG stylesheet.");
  /** @type {Rule[]} */
  const rules = [];
  for (const node of ast.children) {
    if (node.type !== "Rule" || node.prelude.type !== "SelectorList")
      throw new Error("SVG CSS at-rules and nested rules are not supported.");
    const body = declarations(css.generate(node.block).slice(1, -1));
    for (const selector of node.prelude.children) rules.push({ ...compileSelector(selector), declarations: body });
    if (rules.length > LIMITS.cssRules) throw new Error("SVG CSS rule limit exceeded.");
  }
  return rules;
}

/** @param {string} value @returns {Set<string>} */
export function variableNames(value) {
  const names = new Set();
  css.walk(parse(value, "value"), (node) => {
    if (node.type === "Raw") for (const name of variableNames(node.value)) names.add(name);
    if (node.type === "Function" && css.ident.decode(node.name).toLowerCase() === "var") {
      const first = node.children.first;
      if (first?.type === "Identifier") names.add(css.ident.decode(first.name));
    }
  });
  return names;
}

class InvalidVariable extends Error {}

/** Resolve parsed values, not string substitutions. @param {string} text @param {(name:string)=>string} variable @param {number} [depth] @returns {string} */
function resolveValue(text, variable, depth = 0) {
  if (depth > 64) throw new Error("SVG CSS nesting limit exceeded.");
  const ast = parse(text, "value");
  inspectValue(ast);
  css.walk(ast, {
    /** @type {import('css-tree').EnterOrLeaveFn} */
    leave(node, item, list) {
      if (node.type !== "Function" || !item || !list) return;
      const name = css.ident.decode(node.name).toLowerCase();
      let value;
      if (name === "var") {
        const parts = node.children.toArray();
        const first = parts[0];
        if (first?.type !== "Identifier" || !first.name.startsWith("--")) throw new Error("Invalid SVG CSS variable.");
        try {
          value = variable(css.ident.decode(first.name));
        } catch (error) {
          if (!(error instanceof InvalidVariable)) throw error;
          if (parts[1]?.type !== "Operator" || parts[1].value !== ",") throw error;
          value = resolveValue(
            parts
              .slice(2)
              .map((part) => css.generate(part))
              .join(" "),
            variable,
            depth + 1,
          );
        }
      } else if (name === "color-mix") value = mixColor(node);
      else if (name === "min" || name === "max") {
        const numbers = node.children.toArray().filter((part) => part.type !== "Operator");
        if (!numbers.length || numbers.some((part) => part.type !== "Dimension" || part.unit !== "px"))
          throw new Error("Only pixel min/max CSS values are supported.");
        const values = numbers.map((part) => Number(/** @type {import('css-tree').Dimension} */ (part).value));
        value = `${name === "min" ? Math.min(...values) : Math.max(...values)}px`;
      } else return;
      const replacement = parse(value, "value");
      if (replacement.type !== "Value") throw new Error("Invalid resolved SVG CSS value.");
      list.replace(item, replacement.children);
    },
  });
  const output = css.generate(ast);
  if (output.length > LIMITS.svgBytes) throw new Error("Resolved SVG CSS exceeds the size limit.");
  return output;
}

/** @param {string} text @returns {number[]} */
function color(text) {
  const names = /** @type {Record<string,string>} */ ({
    black: "#000000",
    white: "#ffffff",
    red: "#ff0000",
    blue: "#0000ff",
    green: "#008000",
    yellow: "#ffff00",
    gray: "#808080",
    grey: "#808080",
    transparent: "#00000000",
  });
  text = names[text.toLowerCase()] ?? text;
  const ast = parse(text, "value");
  if (ast.type !== "Value" || ast.children.size !== 1) throw new Error("Unsupported mixed SVG color.");
  const node = ast.children.first;
  if (node?.type === "Hash") {
    let hex = node.value;
    if (hex.length === 3 || hex.length === 4) hex = [...hex].map((c) => c + c).join("");
    if (!/^[\da-f]{6}([\da-f]{2})?$/i.test(hex)) throw new Error("Invalid SVG color.");
    return [0, 2, 4, 6].map((at) =>
      at === 6 && hex.length === 6 ? 1 : Number.parseInt(hex.slice(at, at + 2), 16) / 255,
    );
  }
  if (node?.type !== "Function" || !["rgb", "rgba", "hsl", "hsla"].includes(node.name))
    throw new Error("Unsupported color in SVG color-mix.");
  const tokens = node.children.toArray().filter((part) => part.type !== "Operator");
  if (tokens.length < 3 || tokens.length > 4) throw new Error("Invalid mixed SVG color.");
  const values = tokens.map((part, i) => {
    if (part.type === "Percentage") return Number(part.value) / 100;
    if (part.type === "Number") return Number(part.value) / (i < 3 && node.name.startsWith("rgb") ? 255 : 1);
    throw new Error("Unsupported mixed SVG color component.");
  });
  if (node.name.startsWith("hsl")) {
    const [hue, saturation, lightness] = values;
    for (let i = 0; i < 3; i++) {
      const k = (i * 8 + hue / 30) % 12;
      values[i] = lightness - saturation * Math.min(lightness, 1 - lightness) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    }
  }
  return [...values.slice(0, 3).map((v) => Math.max(0, Math.min(1, v))), Math.max(0, Math.min(1, values[3] ?? 1))];
}

/** @param {import('css-tree').FunctionNode} node */
function mixColor(node) {
  const groups = /** @type {CssNode[][]} */ ([[]]);
  for (const part of node.children) {
    if (part.type === "Operator" && part.value === ",") groups.push([]);
    else groups.at(-1)?.push(part);
  }
  if (groups.length !== 3 || groups[0].map((p) => css.generate(p)).join(" ") !== "in srgb")
    throw new Error("Only sRGB color-mix is supported.");
  const stops = groups.slice(1).map((parts) => {
    const last = parts.at(-1);
    const weight = last?.type === "Percentage" ? Number(last.value) / 100 : undefined;
    if (weight !== undefined) parts.pop();
    return { rgba: color(parts.map((p) => css.generate(p)).join(" ")), weight };
  });
  let a = stops[0].weight ?? (stops[1].weight === undefined ? 0.5 : 1 - stops[1].weight);
  let b = stops[1].weight ?? 1 - a;
  if (a < 0 || b < 0 || a > 1 || b > 1 || a + b === 0) throw new Error("Invalid SVG color-mix weights.");
  const sum = a + b;
  a /= sum;
  b /= sum;
  const alpha = stops[0].rgba[3] * a + stops[1].rgba[3] * b;
  const rgb = [0, 1, 2].map((i) =>
    Math.round(
      255 * (alpha ? (stops[0].rgba[i] * stops[0].rgba[3] * a + stops[1].rgba[i] * stops[1].rgba[3] * b) / alpha : 0),
    ),
  );
  return `rgba(${rgb.join(",")},${alpha * Math.min(sum, 1)})`;
}

/** Expand only the static, supported font shorthand; resvg needs explicit font attributes. @param {string} value @returns {Declaration[]} */
function fontDeclarations(value) {
  const ast = parse(value, "value");
  if (ast.type !== "Value") throw new Error("Invalid SVG font shorthand.");
  const tokens = ast.children.toArray();
  const at = tokens.findIndex((node) => node.type === "Dimension" && ["px", "pt", "em"].includes(node.unit));
  if (at < 0 || tokens[at + 1]?.type === "Operator") throw new Error("Unsupported SVG font shorthand.");
  const result = ["font-style", "font-weight", "font-variant", "font-stretch"].map((property) => ({
    property,
    value: "normal",
    important: false,
  }));
  result.push(
    { property: "font-size", value: css.generate(tokens[at]), important: false },
    {
      property: "font-family",
      value: tokens
        .slice(at + 1)
        .map((p) => css.generate(p))
        .join(" "),
      important: false,
    },
  );
  for (const part of tokens.slice(0, at)) {
    const text = css.generate(part);
    if (["italic", "oblique"].includes(text)) result.push({ property: "font-style", value: text, important: false });
    else if (["normal", "bold", "bolder", "lighter"].includes(text) || part.type === "Number")
      result.push({ property: "font-weight", value: text, important: false });
    else throw new Error("Unsupported SVG font shorthand.");
  }
  return result;
}

/** Bake the supported cascade to attributes, with custom properties computed at their declaration scope.
 * @param {Element[]} elements @param {Rule[]} rules @param {Record<string,string>} defaults @param {Set<string>} ids
 */
export function bakeCss(elements, rules, defaults, ids) {
  /** @type {Map<Element, Map<string,string>>} */
  const environments = new Map();
  for (const element of elements) {
    /** @type {Map<string,{value:string,score:number,order:number}>} */
    const selected = new Map();
    let order = 0;
    /** @param {Declaration} declaration @param {number} specificity */
    const add = (declaration, specificity) => {
      const score = specificity + (declaration.important ? 10_000_000 : 0);
      const previous = selected.get(declaration.property);
      if (!previous || score > previous.score || (score === previous.score && order > previous.order)) {
        selected.set(declaration.property, { value: declaration.value, score, order });
      }
      order++;
    };
    for (const attribute of Array.from(element.attributes)) {
      if (PRESENTATION.has(attribute.name))
        add({ property: attribute.name, value: attribute.value, important: false }, -1);
    }
    for (const rule of rules)
      if (rule.test(element)) for (const declaration of rule.declarations) add(declaration, rule.specificity);
    for (const declaration of declarations(element.getAttribute("style") ?? "")) add(declaration, 1_000_000);
    const parent = /** @type {Element} */ (element.parentNode);
    const inherited = environments.get(parent) ?? new Map(Object.entries(defaults));
    const variables = new Map(inherited);
    /** @type {Map<string,string>} */
    const local = new Map();
    for (const [property, declaration] of selected)
      if (property.startsWith("--")) local.set(property, declaration.value);
    // CSS cycles include dependencies inside unused fallbacks. Reject this unsupported case explicitly.
    const dependencies = new Map([...local].map(([name, value]) => [name, variableNames(value)]));
    const path = new Set();
    const checked = new Set();
    /** @param {string} name */
    const checkCycle = (name) => {
      if (path.has(name)) throw new Error("Cyclic SVG CSS variable declarations are not supported.");
      if (checked.has(name)) return;
      if (path.size > 64) throw new Error("SVG CSS variable nesting limit exceeded.");
      path.add(name);
      for (const dep of dependencies.get(name) ?? []) if (local.has(dep)) checkCycle(dep);
      path.delete(name);
      checked.add(name);
    };
    for (const name of local.keys()) checkCycle(name);
    const computing = new Set();
    /** @param {string} name @returns {string} */
    const variable = (name) => {
      if (computing.has(name)) throw new InvalidVariable("Cyclic SVG CSS variable.");
      const raw = local.get(name);
      if (raw === undefined) {
        const value = variables.get(name);
        if (value === undefined) throw new InvalidVariable(`Unresolved SVG CSS variable: ${name}`);
        return value;
      }
      computing.add(name);
      try {
        const value = raw === "inherit" || raw === "unset" ? inherited.get(name) : resolveValue(raw, variable);
        if (value === undefined || raw === "initial") throw new InvalidVariable(`Unresolved SVG CSS variable: ${name}`);
        variables.set(name, value);
        local.delete(name);
        return value;
      } finally {
        computing.delete(name);
      }
    };
    for (const name of [...local.keys()]) {
      try {
        variable(name);
      } catch (error) {
        if (!(error instanceof InvalidVariable)) throw error;
        local.delete(name);
        variables.delete(name);
      }
    }
    environments.set(element, variables);
    // Font shorthand is expanded before longhands at the same cascade position.
    const properties = [...selected]
      .filter(([p]) => !p.startsWith("--"))
      .sort((a, b) => a[1].score - b[1].score || a[1].order - b[1].order);
    for (const [property, declaration] of properties) {
      const value = resolveValue(declaration.value, (name) => {
        const found = variables.get(name);
        if (found === undefined) throw new InvalidVariable(`Unresolved SVG CSS variable: ${name}`);
        return found;
      });
      const expanded = property === "font" ? fontDeclarations(value) : [{ property, value }];
      for (const item of expanded) {
        const valueTokens = parse(item.value, "value");
        const onlyToken =
          valueTokens.type === "Value" && valueTokens.children.size === 1 ? valueTokens.children.first : null;
        const keyword = onlyToken?.type === "Identifier" ? css.ident.decode(onlyToken.name).toLowerCase() : undefined;
        if (keyword && ["initial", "unset", "revert", "revert-layer"].includes(keyword))
          throw new Error("Unsupported SVG CSS global keyword.");
        if (item.property === "display" && !["inline", "none", "inherit"].includes(item.value))
          throw new Error("Unsupported SVG display value.");
        if (item.property === "visibility" && !["visible", "hidden", "inherit"].includes(item.value))
          throw new Error("Unsupported SVG visibility value.");
        if (item.property === "text-transform" || item.property === "direction") {
          if (item.value !== (item.property === "direction" ? "ltr" : "none"))
            throw new Error(`Unsupported SVG CSS ${item.property}.`);
          continue;
        }
        // SVG presentation attributes also permit unitless user-space lengths.
        const checkedValue =
          ["font-size", "rx", "ry", "letter-spacing", "word-spacing", "baseline-shift"].includes(item.property) &&
          /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(item.value)
            ? `${item.value}px`
            : item.value;
        if (css.lexer.matchProperty(item.property, checkedValue).error)
          throw new Error(`Unsupported SVG CSS value for ${item.property}.`);
        const valueAst = parse(item.value, "value");
        css.walk(valueAst, (node) => {
          if (node.type === "Url" && !ids.has(localReference(node.value)))
            throw new Error("Missing SVG reference target.");
        });
        element.setAttribute(item.property, item.value);
      }
    }
    element.removeAttribute("style");
  }
}
