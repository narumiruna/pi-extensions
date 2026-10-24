import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "vitest";

test("publish workflow uses native Changesets artifact publishing without duplicate root gates", () => {
  const workflow = readFileSync(path.join(process.cwd(), ".github/workflows/publish.yml"), "utf8");
  const publish = workflow.slice(workflow.indexOf("  publish:\n"));
  assert.match(publish, /actions\/download-artifact@[a-f0-9]{40}/u);
  assert.match(publish, /artifact-ids: \$\{\{ needs\.pack\.outputs\.pack-dir-artifact-id \}\}/u);
  assert.match(
    publish,
    /script: npm run publish-packages -- --from-pack-dir \$\{\{ runner\.temp \}\}\/changeset-pack/u,
  );
  const manifest = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
  assert.equal(manifest.scripts["publish-packages"], "changeset publish");
  assert.match(publish, /create-github-releases: true/u);
  assert.match(publish, /push-git-tags: true/u);
  assert.match(publish, /NPM_CONFIG_PROVENANCE: "true"/u);
  assert.match(publish, /if: always\(\)/u);
  assert.doesNotMatch(publish, /npm (?:run check|test)/u);
  assert.doesNotMatch(publish, /publish-coordinated-packages|npm view|npm pack/u);
});
