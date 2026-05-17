#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const EXTENSION_PACKAGE_RE = /^@narumitw\/pi-/;
const DEPENDENCY_FIELDS = [
	"dependencies",
	"devDependencies",
	"peerDependencies",
	"optionalDependencies",
];
const SOURCE_EXTENSIONS = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);
const MODULE_SPECIFIER_RE =
	/\b(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s+)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;

const rootDirectory = process.cwd();
const extensionsDirectory = path.join(rootDirectory, "extensions");
const activePackages = findActiveExtensionPackages(extensionsDirectory);
const failures = [];

for (const extensionPackage of activePackages) {
	checkPackageDependencies(extensionPackage);
	checkSourceImports(extensionPackage);
}

if (failures.length > 0) {
	console.error("Extension boundary check failed:");
	for (const failure of failures) console.error(`- ${failure}`);
	process.exit(1);
}

console.log(
	`Extension boundary check passed: ${activePackages.length} active packages have no extension-to-extension dependencies.`,
);

function findActiveExtensionPackages(directory) {
	const packages = [];

	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.name === "deprecated") continue;

		const packagePath = path.join(directory, entry.name, "package.json");
		if (!fs.existsSync(packagePath)) continue;

		const packageJson = readJson(packagePath);
		if (typeof packageJson.name !== "string") {
			throw new Error(`${relative(packagePath)} must define a package name.`);
		}

		packages.push({
			directory: path.dirname(packagePath),
			name: packageJson.name,
			packageJson,
			packagePath,
		});
	}

	return packages.sort((left, right) => left.name.localeCompare(right.name));
}

function checkPackageDependencies(extensionPackage) {
	for (const field of DEPENDENCY_FIELDS) {
		const dependencies = extensionPackage.packageJson[field];
		if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) continue;

		for (const dependencyName of Object.keys(dependencies)) {
			if (!isForbiddenExtensionReference(extensionPackage.name, dependencyName)) continue;

			failures.push(
				`${relative(extensionPackage.packagePath)} ${field} must not reference ${dependencyName}.`,
			);
		}
	}
}

function checkSourceImports(extensionPackage) {
	const sourceDirectory = path.join(extensionPackage.directory, "src");
	if (!fs.existsSync(sourceDirectory)) return;

	for (const sourcePath of listSourceFiles(sourceDirectory)) {
		const source = fs.readFileSync(sourcePath, "utf8");
		for (const specifier of moduleSpecifiers(source)) {
			if (!isForbiddenExtensionReference(extensionPackage.name, specifier)) continue;

			failures.push(`${relative(sourcePath)} must not import ${specifier}.`);
		}
	}
}

function listSourceFiles(directory) {
	const files = [];
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		const entryPath = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			files.push(...listSourceFiles(entryPath));
			continue;
		}
		if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) files.push(entryPath);
	}
	return files.sort();
}

function moduleSpecifiers(source) {
	const specifiers = [];
	MODULE_SPECIFIER_RE.lastIndex = 0;
	while (true) {
		const match = MODULE_SPECIFIER_RE.exec(source);
		if (match === null) break;
		const specifier = match[1] ?? match[2] ?? match[3];
		if (specifier) specifiers.push(specifier);
	}
	return specifiers;
}

function isForbiddenExtensionReference(packageName, specifier) {
	return specifier !== packageName && EXTENSION_PACKAGE_RE.test(specifier);
}

function readJson(filePath) {
	return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function relative(filePath) {
	return path.relative(rootDirectory, filePath) || filePath;
}
