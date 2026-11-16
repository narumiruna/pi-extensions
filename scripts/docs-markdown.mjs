import { posix } from "node:path";

const repositoryUrl = "https://github.com/narumiruna/pi-extensions";
// Python-Markdown processes these escapes and code spans before links and images.
const escapedCharacters = new Set("\\`*_{}[]()>#+-.!");

function encodePath(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function syntaxMask(line) {
  const masked = line.split("");
  const hide = (start, end) => masked.fill("\0", start, end);
  for (let index = 0; index < line.length; index++) {
    if (line[index] === "\\" && escapedCharacters.has(line[index + 1])) {
      hide(index, index + 2);
      index++;
    } else if (line[index] === "`") {
      let start = index;
      while (line[start] === "`") start++;
      const length = start - index;
      let end;
      let longest = 0;
      let fallback;
      for (let cursor = start; cursor < line.length; cursor++) {
        if (line[cursor] !== "`") continue;
        let next = cursor;
        while (line[next] === "`") next++;
        const count = next - cursor;
        if (count === length) {
          end = next;
          break;
        }
        if (count > longest) {
          longest = count;
          fallback = next;
        }
        cursor = next - 1;
      }
      if (end === undefined && longest > 0 && longest < length) end = fallback;
      if (end !== undefined) hide(index, end);
      index = (end ?? start) - 1;
    }
  }
  return masked.join("");
}

function inlineDestination(line, masked, labelEnd) {
  if (line[labelEnd + 1] !== "(") return undefined;
  let start = labelEnd + 2;
  while (/\s/.test(line[start] ?? "") && start < line.length) start++;
  let end = start;
  if (line[start] === "<") {
    end = masked.indexOf(">", start + 1);
    if (end < 0 || masked.slice(start + 1, end).includes("<")) return undefined;
    end++;
  } else {
    let depth = 0;
    for (; end < line.length; end++) {
      const char = line[end];
      if (char === "\\" && escapedCharacters.has(line[end + 1])) end++;
      else if (char === "(") depth++;
      else if (char === ")") {
        if (depth === 0) break;
        depth--;
      } else if (/\s/.test(char)) break;
    }
    if (depth !== 0 || end === start) return undefined;
  }
  const tail = line.slice(end).match(/^(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'))?[ \t]*\)/);
  return tail ? { start, end, after: end + tail[0].length } : undefined;
}

const referencePattern = /^([ ]{0,3}\[(?!\^)[^[\]]*\]:[ ]*)(\S+)([ ]*(?:(["']).*\4[ ]*|\(.*\)[ ]*)?)$/;

function rewriteInline(line, rewrite, references, allowLinks = true) {
  const masked = syntaxMask(line);
  let result = "";
  let copied = 0;
  for (let index = 0; index < line.length; index++) {
    if (masked[index] !== "[") continue;
    const image = masked[index - 1] === "!";
    if (!allowLinks && !image) continue;
    let depth = 1;
    let closing = index + 1;
    for (; closing < line.length; closing++) {
      if (masked[closing] === "[") depth++;
      else if (masked[closing] === "]" && --depth === 0) break;
    }
    if (depth !== 0) continue;
    const link = inlineDestination(line, masked, closing);
    const reference = line.slice(closing + 1).match(/^\s?\[([^\]]*)\]/);
    const label = line.slice(index + 1, closing);
    const id = (reference?.[1] || label).toLowerCase();
    if (!link && !references.has(id)) continue;
    const after = link?.after ?? closing + 1 + (reference?.[0].length ?? 0);
    // Python-Markdown suppresses nested links in inline link labels, but not in
    // reference link labels. Image alt text does not activate either form.
    result += line.slice(copied, index + 1) + (image ? label : rewriteInline(label, rewrite, references, !link));
    result += line.slice(closing, link?.start ?? after);
    if (link) result += rewrite(line.slice(link.start, link.end), true);
    copied = link?.end ?? after;
    index = after - 1;
  }
  return result + line.slice(copied);
}

export function sitePath(source) {
  return source === "docs/index.md" ? "index.md" : source;
}

// This is a source-preserving rewrite of the documented single-line link forms,
// not a Markdown renderer. Match full labels, including native escape/code precedence.
export function rewriteLinks(markdown, source, files, repositoryPaths) {
  const destination = (href, inline) => {
    const raw = inline ? href.replace(/\\(.)/g, (match, char) => (escapedCharacters.has(char) ? char : match)) : href;
    if (/^(?:[a-z][a-z\d+.-]*:|\/|#|\?)/i.test(raw)) return href;
    const [, pathname, suffix = ""] = raw.match(/^([^?#]*)(.*)$/);
    const target = posix.normalize(posix.join(posix.dirname(source), decodeURIComponent(pathname)));
    if (!repositoryPaths.has(target)) throw new Error(`${source}: missing link target ${href}`);
    const encoded = (path) => path.split("/").map(encodePath).join("/");
    const safeSuffix = suffix.replace(/[\\()<>\s[\]]/g, encodePath);
    if (files.has(target)) {
      return `${encoded(posix.relative(posix.dirname(sitePath(source)), sitePath(target)))}${safeSuffix}`;
    }
    const kind = repositoryPaths.get(target) === "directory" ? "tree" : "blob";
    return `${repositoryUrl}/${kind}/main/${encoded(target)}${safeSuffix}`;
  };

  const lines = markdown.split("\n");
  let fence;
  const protectedLines = lines.map((line) => {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      if (
        marker &&
        marker[1][0] === fence[0] &&
        marker[1].length >= fence.length &&
        line.slice(marker[0].length).trim() === ""
      )
        fence = undefined;
      return true;
    }
    if (marker) fence = marker[1];
    return Boolean(marker);
  });
  const references = new Set(
    lines.flatMap((line, index) => {
      const definition = !protectedLines[index] && line.match(referencePattern);
      return definition
        ? [
            definition[1]
              .match(/\[([^[\]]*)\]/)[1]
              .trim()
              .toLowerCase(),
          ]
        : [];
    }),
  );
  const rewrite = (href, inline) =>
    href.startsWith("<") && href.endsWith(">")
      ? "<" + destination(href.slice(1, -1), inline) + ">"
      : destination(href, inline);
  return lines
    .map((line, index) => {
      if (protectedLines[index]) return line;
      const reference = line.match(referencePattern);
      if (reference) return reference[1] + rewrite(reference[2], false) + reference[3];
      return rewriteInline(line, rewrite, references);
    })
    .join("\n");
}
