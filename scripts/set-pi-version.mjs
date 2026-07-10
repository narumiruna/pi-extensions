#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const version = process.argv[2];
if (!version) {
	console.error("Usage: node scripts/set-pi-version.mjs <version>");
	process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionsDir = path.join(root, "extensions");
const manifests = [
	path.join(root, "package.json"),
	...fs
		.readdirSync(extensionsDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => path.join(extensionsDir, entry.name, "package.json"))
		.filter((manifest) => fs.existsSync(manifest)),
];

let updatedDependencies = 0;
for (const manifest of manifests) {
	const packageJson = JSON.parse(fs.readFileSync(manifest, "utf8"));
	let changed = false;

	for (const dependencyType of ["dependencies", "devDependencies"]) {
		for (const packageName of Object.keys(packageJson[dependencyType] ?? {})) {
			if (!packageName.startsWith("@earendil-works/pi-")) continue;
			packageJson[dependencyType][packageName] = version;
			updatedDependencies += 1;
			changed = true;
		}
	}

	if (changed) {
		fs.writeFileSync(manifest, `${JSON.stringify(packageJson, null, "\t")}\n`);
	}
}

if (updatedDependencies === 0) {
	console.error("No @earendil-works/pi-* dependencies found");
	process.exit(1);
}

console.log(`Set ${updatedDependencies} Pi dependencies to ${version}.`);
