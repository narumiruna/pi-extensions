import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";

const { prepareDocs, rewriteLinks } = (await import(pathToFileURL(resolve("scripts/docs.mjs")).href)) as {
  prepareDocs(root: string): Promise<number>;
  rewriteLinks(markdown: string, source: string, files: Set<string>, repositoryPaths: Map<string, string>): string;
};

const github = "https://github.com/narumiruna/pi-extensions";
const files = new Set([
  "docs/index.md",
  "docs/guide.md",
  "docs/guide(intro).md",
  "docs/guide(nested(one)).md",
  "docs/guide).md",
  "docs/guide(.md",
  "docs/guide[x].md",
  "docs/guide#topic.md",
  "docs/guide?query.md",
  "docs/guide>.md",
  "docs/guide'quote.md",
  "docs/guide%name.md",
  "docs/with space.md",
  "docs/image.svg",
  "packages/example/docs/topic.md",
]);
const repositoryPaths = new Map([
  ...[...files].map((path): [string, string] => [path, "file"]),
  ["README.md", "file"],
  ["packages/example/README.md", "file"],
  ["packages/example/src/index.ts", "file"],
  ["packages/example/src/guide).ts", "file"],
  ["packages/example", "directory"],
]);

for (const [name, source, input, expected] of [
  ["home links are relocated", "docs/index.md", "[Guide](guide.md#topic)", "[Guide](docs/guide.md#topic)"],
  ["parenthesized paths survive", "docs/index.md", "[Guide](guide(intro).md)", "[Guide](docs/guide%28intro%29.md)"],
  ["escaped closing parentheses survive", "docs/index.md", "[Guide](guide\\).md)", "[Guide](docs/guide%29.md)"],
  ["escaped opening parentheses survive", "docs/index.md", "[Guide](guide\\(.md)", "[Guide](docs/guide%28.md)"],
  ["angle parentheses survive", "docs/index.md", "[Guide](<guide).md>)", "[Guide](<docs/guide%29.md>)"],
  ["escaped brackets survive", "docs/index.md", "[Guide](guide\\[x\\].md)", "[Guide](docs/guide%5Bx%5D.md)"],
  [
    "encoded path separators stay in the filename",
    "docs/index.md",
    "[Guide](guide%23topic.md)",
    "[Guide](docs/guide%23topic.md)",
  ],
  ["reference parentheses survive", "docs/index.md", "[guide]: guide).md", "[guide]: docs/guide%29.md"],
  [
    "encoded question marks stay in the path",
    "docs/index.md",
    "[Guide](guide%3Fquery.md)",
    "[Guide](docs/guide%3Fquery.md)",
  ],
  ["escaped angle closers stay in the path", "docs/index.md", "[Guide](<guide\\>.md>)", "[Guide](<docs/guide%3E.md>)"],
  [
    "angle paths encode quote delimiters",
    "docs/index.md",
    "[Guide](<guide'quote.md>)",
    "[Guide](<docs/guide%27quote.md>)",
  ],
  [
    "literal percent signs are encoded once",
    "docs/index.md",
    "[Guide](guide%25name.md)",
    "[Guide](docs/guide%25name.md)",
  ],
  [
    "fragment delimiters cannot close destinations",
    "docs/index.md",
    "[Guide](guide.md#part\\))",
    "[Guide](docs/guide.md#part%29)",
  ],
  [
    "external source paths encode delimiters",
    "docs/index.md",
    "[Source](../packages/example/src/guide\\).ts)",
    `[Source](${github}/blob/main/packages/example/src/guide%29.ts)`,
  ],
  [
    "image alt text cannot activate nested links",
    "docs/index.md",
    "![outer [inner](missing.md)](image.svg)",
    "![outer [inner](missing.md)](docs/image.svg)",
  ],
  [
    "escaped label closers are text inside a real label",
    "docs/index.md",
    "[Guide \\] end](guide.md)",
    "[Guide \\] end](docs/guide.md)",
  ],
  ["escaped link labels remain literal", "docs/index.md", "\\[example](missing.md)", "\\[example](missing.md)"],
  ["escaped image labels remain literal", "docs/index.md", "!\\[example](missing.md)", "!\\[example](missing.md)"],
  [
    "an escaped image marker leaves an active link",
    "docs/index.md",
    "\\![Guide](guide.md)",
    "\\![Guide](docs/guide.md)",
  ],
  ["even backslashes leave an active link", "docs/index.md", "\\\\[Guide](guide.md)", "\\\\[Guide](docs/guide.md)"],
  [
    "odd backslashes leave a literal label",
    "docs/index.md",
    "\\\\\\[example](missing.md)",
    "\\\\\\[example](missing.md)",
  ],
  ["escaped closing labels remain literal", "docs/index.md", "[example\\](missing.md)", "[example\\](missing.md)"],
  ["unmatched closing labels remain literal", "docs/index.md", "example](missing.md)", "example](missing.md)"],
  [
    "nested labels use the outer destination",
    "docs/index.md",
    "[outer [inner](missing.md)](guide.md)",
    "[outer [inner](missing.md)](docs/guide.md)",
  ],
  [
    "inner links work inside literal outer brackets",
    "docs/index.md",
    "[outer [Guide](guide.md)]",
    "[outer [Guide](docs/guide.md)]",
  ],
  ["code brackets do not close labels", "docs/index.md", "[Guide `]` end](guide.md)", "[Guide `]` end](docs/guide.md)"],
  [
    "images inside links keep both destinations",
    "docs/index.md",
    "[![Image](image.svg)](guide.md)",
    "[![Image](docs/image.svg)](docs/guide.md)",
  ],
  [
    "reference labels keep native nested links",
    "docs/index.md",
    "[outer [Guide](guide.md)][ref]\n\n[ref]: guide.md",
    "[outer [Guide](docs/guide.md)][ref]\n\n[ref]: docs/guide.md",
  ],
  [
    "reference usage whitespace is not trimmed",
    "docs/index.md",
    "[outer [Guide](guide.md)][ ref ]\n\n[ref]: guide.md",
    "[outer [Guide](docs/guide.md)][ ref ]\n\n[ref]: docs/guide.md",
  ],
  [
    "images inside reference links are relocated",
    "docs/index.md",
    "[![Image](image.svg)][ref]\n\n[ref]: guide.md",
    "[![Image](docs/image.svg)][ref]\n\n[ref]: docs/guide.md",
  ],
  [
    "unknown references do not hide active links",
    "docs/index.md",
    "[outer [Guide](guide.md)][unknown]",
    "[outer [Guide](docs/guide.md)][unknown]",
  ],
  [
    "unmatched code openers do not hide links",
    "docs/index.md",
    "` literal [Guide](guide.md)",
    "` literal [Guide](docs/guide.md)",
  ],
  [
    "native shorter code fences remain literal",
    "docs/index.md",
    "``[example](missing.md)`",
    "``[example](missing.md)`",
  ],
  [
    "fenced reference examples do not create live references",
    "docs/index.md",
    "```md\n[ref]: guide.md\n```\n[outer [Guide](guide.md)][ref]",
    "```md\n[ref]: guide.md\n```\n[outer [Guide](docs/guide.md)][ref]",
  ],
  [
    "nested parentheses survive",
    "docs/index.md",
    "[Guide](guide(nested(one)).md)",
    "[Guide](docs/guide%28nested%28one%29%29.md)",
  ],
  ["escaped parentheses survive", "docs/index.md", "[Guide](guide\\(intro\\).md)", "[Guide](docs/guide%28intro%29.md)"],
  [
    "angle destinations preserve spaces",
    "docs/index.md",
    "[Guide](<with space.md>)",
    "[Guide](<docs/with%20space.md>)",
  ],
  [
    "quoted titles preserve parentheses",
    "docs/index.md",
    '[Guide](guide.md "(Title)")',
    '[Guide](docs/guide.md "(Title)")',
  ],
  ["incomplete links remain literal", "docs/index.md", "[Guide](missing.md", "[Guide](missing.md"],
  ["links back to home are relocated", "docs/guide.md", "[Home](index.md)", "[Home](../index.md)"],
  [
    "cross-scope links stay internal",
    "docs/guide.md",
    "[Topic](../packages/example/docs/topic.md)",
    "[Topic](../packages/example/docs/topic.md)",
  ],
  [
    "repository README stays external",
    "docs/guide.md",
    "[Install](../README.md#-install)",
    `[Install](${github}/blob/main/README.md#-install)`,
  ],
  [
    "package README stays external",
    "packages/example/docs/topic.md",
    "[Install](../README.md)",
    `[Install](${github}/blob/main/packages/example/README.md)`,
  ],
  [
    "source stays external",
    "docs/guide.md",
    "[Source](../packages/example/src/index.ts)",
    `[Source](${github}/blob/main/packages/example/src/index.ts)`,
  ],
  [
    "directories use tree links",
    "docs/guide.md",
    "[Package](../packages/example)",
    `[Package](${github}/tree/main/packages/example)`,
  ],
  [
    "assets and link titles survive",
    "docs/index.md",
    '![Image](image.svg "Preview")',
    '![Image](docs/image.svg "Preview")',
  ],
  [
    "reference definitions preserve titles",
    "docs/index.md",
    '[guide]: <guide.md?view=1#topic> "Title"',
    '[guide]: <docs/guide.md?view=1#topic> "Title"',
  ],
  [
    "external and fragment links survive",
    "docs/guide.md",
    "[Web](https://example.com/a_(b)) [Mail](mailto:a@example.com) [CDN](//example.com) [Root](/path) [Local](#-topic)",
    "[Web](https://example.com/a_(b)) [Mail](mailto:a@example.com) [CDN](//example.com) [Root](/path) [Local](#-topic)",
  ],
  [
    "inline code is literal",
    "docs/index.md",
    "`[example](missing.md)` and ``[example](also-missing.md)``",
    "`[example](missing.md)` and ``[example](also-missing.md)``",
  ],
  [
    "fenced examples are literal",
    "docs/index.md",
    "````md\n[example](missing.md)\n```\n[still literal](missing.md)\n````\n[Guide](guide.md)",
    "````md\n[example](missing.md)\n```\n[still literal](missing.md)\n````\n[Guide](docs/guide.md)",
  ],
  [
    "nested tilde fences are literal",
    "docs/index.md",
    "    ~~~md\n    [example](missing.md)\n    ~~~",
    "    ~~~md\n    [example](missing.md)\n    ~~~",
  ],
  [
    "footnotes are not link definitions",
    "docs/guide.md",
    "[^note]: This is a footnote.",
    "[^note]: This is a footnote.",
  ],
]) {
  test(`documentation links: ${name}`, () => {
    assert.equal(rewriteLinks(input, source, files, repositoryPaths), expected);
  });
}

test("missing documentation links fail with the owning source path", () => {
  assert.throws(
    () =>
      rewriteLinks("[outer [Missing](missing.md)][ref]\n\n[ref]: guide.md", "docs/index.md", files, repositoryPaths),
    /docs\/index.md: missing link target missing.md/,
  );
  assert.throws(
    () => rewriteLinks("[Missing](missing.md)", "docs/guide.md", files, repositoryPaths),
    /docs\/guide.md: missing link target missing.md/,
  );
});

async function fixture(run: (root: string, output: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "pi-docs-site-"));
  try {
    execFileSync("git", ["init", "--quiet", root]);
    await mkdir(join(root, "docs"));
    await mkdir(join(root, "packages/example/docs"), { recursive: true });
    await mkdir(join(root, "packages/example/src"));
    await mkdir(join(root, "deprecated/old/docs"), { recursive: true });
    await writeFile(join(root, ".gitignore"), ".zensical-docs/\ndocs/private/\n");
    await writeFile(join(root, "README.md"), "# Repository\n");
    await writeFile(join(root, "docs/index.md"), "# Home\n\n[Guide](guide.md)\n[Install](../README.md)\n");
    await writeFile(join(root, "docs/guide.md"), "# Guide\n");
    await writeFile(join(root, "docs/evidence.json"), '{"observed":true}\n');
    await writeFile(join(root, "packages/example/docs/topic.md"), "# Topic\n");
    await writeFile(join(root, "packages/example/src/index.ts"), "export {};\n");
    await writeFile(join(root, "deprecated/old/docs/obsolete.md"), "# Obsolete\n");
    await mkdir(join(root, "docs/private"));
    await writeFile(join(root, "docs/private/draft.md"), "# Private draft\n");
    await run(root, join(root, ".zensical-docs"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("staging includes only non-ignored documentation scopes without changing sources", async () => {
  await fixture(async (root, output) => {
    const source = await readFile(join(root, "docs/index.md"), "utf8");
    assert.equal(await prepareDocs(root), 4);
    assert.equal(await readFile(join(root, "docs/index.md"), "utf8"), source);
    assert.equal(
      await readFile(join(output, "index.md"), "utf8"),
      `# Home\n\n[Guide](docs/guide.md)\n[Install](${github}/blob/main/README.md)\n`,
    );
    assert.equal(await readFile(join(output, "docs/evidence.json"), "utf8"), '{"observed":true}\n');
    assert.ok(existsSync(join(output, "packages/example/docs/topic.md")));
    for (const path of [
      "README.md",
      "docs/index.md",
      "docs/private/draft.md",
      "deprecated/old/docs/obsolete.md",
      "packages/example/src/index.ts",
    ]) {
      assert.equal(existsSync(join(output, path)), false, path);
    }
    const modified = (await stat(join(output, "index.md"))).mtimeMs;
    await prepareDocs(root);
    assert.equal((await stat(join(output, "index.md"))).mtimeMs, modified, "unchanged pages must not trigger reloads");
  });
});

test("staging updates edits, removes deleted tracked pages, and preserves the last good tree on link failure", async () => {
  await fixture(async (root, output) => {
    execFileSync("git", ["add", "docs/guide.md"], { cwd: root });
    await prepareDocs(root);
    await writeFile(join(root, "packages/example/docs/topic.md"), "# Updated topic\n");
    await rm(join(root, "docs/guide.md"));
    await writeFile(join(root, "docs/index.md"), "# Updated home\n");
    assert.equal(await prepareDocs(root), 3);
    assert.equal(existsSync(join(output, "docs/guide.md")), false);
    assert.equal(await readFile(join(output, "packages/example/docs/topic.md"), "utf8"), "# Updated topic\n");
    await writeFile(join(root, "docs/index.md"), "# Invalid home\n[Missing](missing.md)\n");
    await assert.rejects(prepareDocs(root), /missing link target/);
    assert.equal(await readFile(join(output, "index.md"), "utf8"), "# Updated home\n");
  });
});

test("staging supports file and directory replacements in both directions", async () => {
  await fixture(async (root, output) => {
    const asset = join(root, "docs/assets");
    await mkdir(asset);
    await writeFile(join(asset, "icon.svg"), "<svg/>");
    await prepareDocs(root);
    await rm(asset, { recursive: true });
    await writeFile(asset, "asset file");
    await prepareDocs(root);
    assert.equal(await readFile(join(output, "docs/assets"), "utf8"), "asset file");
    await rm(asset);
    await mkdir(asset);
    await writeFile(join(asset, "icon.svg"), "<svg>updated</svg>");
    await prepareDocs(root);
    assert.equal(await readFile(join(output, "docs/assets/icon.svg"), "utf8"), "<svg>updated</svg>");
  });
});

test("staging rejects symlink assets instead of copying outside content", async () => {
  await fixture(async (root) => {
    await symlink(join(root, "README.md"), join(root, "docs/linked.md"));
    await assert.rejects(prepareDocs(root), /Documentation must be a regular file: docs\/linked.md/);
  });
});

test("site navigation covers scoped documents and resolves to real source files", async () => {
  const config = await readFile("zensical.toml", "utf8");
  const routes = [...config.matchAll(/= "([^"]+\.md)"/g)].map((match) =>
    match[1] === "index.md" ? "docs/index.md" : match[1],
  );
  assert.equal(new Set(routes).size, routes.length, "navigation must not duplicate pages");
  for (const path of routes) assert.ok(existsSync(path), `missing navigation page: ${path}`);
  const compatibilityPages = new Set([
    "docs/api/accounts-v1.md",
    "docs/api/oauth-credential-readiness-v1.md",
    "docs/api/oauth-credential-source-v1.md",
    "packages/pi-usage/docs/providers.md",
  ]);
  const sources = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    encoding: "utf8",
  })
    .split("\0")
    .filter((path) => /^(?:docs\/|packages\/[^/]+\/docs\/).*\.md$/.test(path) && existsSync(path));
  for (const path of sources)
    assert.ok(routes.includes(path) || compatibilityPages.has(path), `document is not discoverable: ${path}`);
  assert.match(config, /docs_dir = "\.zensical-docs"/, "Zensical --clean must not delete staged sources");
  assert.match(config, /use_directory_urls = false/, "file URLs avoid providers.md and providers/README.md collisions");
  assert.match(config, /toc\.slugify = .*pymdownx\.slugs\.slugify/, "preserve GitHub-style emoji fragments");
});
