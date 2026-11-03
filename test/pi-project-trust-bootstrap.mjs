import { pathToFileURL } from "node:url";

// Report child readiness before Pi imports, so scheduling does not consume its startup deadline.
process.send({ type: "ready" });
const [cli, savedUpdates, ...args] = process.argv.slice(2);
const { ProjectTrustStore, hasTrustRequiringProjectResources } = await import("@earendil-works/pi-coding-agent");
const store = new ProjectTrustStore(process.env.PI_CODING_AGENT_DIR);
const updates = JSON.parse(savedUpdates);
if (updates.length > 0) store.setMany(updates);
process.send({
  type: "saved_decision",
  decision: store.get(process.cwd()),
  requiresTrust: hasTrustRequiringProjectResources(process.cwd()),
});

// Preserve normal CLI argument parsing and load the manifest's package-bin entry, not dist/cli.js.
process.argv = [process.execPath, cli, ...args];
await import(pathToFileURL(cli).href);
