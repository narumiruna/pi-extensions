#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {
	isCallExpression,
	isExportDeclaration,
	isExternalModuleReference,
	isIdentifier,
	isImportDeclaration,
	isImportEqualsDeclaration,
	isNoSubstitutionTemplateLiteral,
	isStringLiteral,
	SyntaxKind,
} from "typescript/unstable/ast";
import { API } from "typescript/unstable/sync";

const EXTENSION_PACKAGE_RE = /^@narumitw\/pi-/;
const DEPENDENCY_FIELDS = [
	"dependencies",
	"devDependencies",
	"peerDependencies",
	"optionalDependencies",
];
const SOURCE_FILE_SUFFIXES = [
	".d.cts",
	".d.mts",
	".d.ts",
	".cjs",
	".cts",
	".js",
	".jsx",
	".mjs",
	".mts",
	".ts",
	".tsx",
];

const rootDirectory = process.cwd();
const extensionsDirectory = path.join(rootDirectory, "extensions");
const activePackages = findActiveExtensionPackages(extensionsDirectory);
const experimentalDirectory = path.join(extensionsDirectory, "experimental") + path.sep;
const experimentalPackageCount = activePackages.filter(({ directory }) =>
	directory.startsWith(experimentalDirectory),
).length;
const failures = [];
const sourcePaths = activePackages.flatMap((extensionPackage) => {
	const sourceDirectory = path.join(extensionPackage.directory, "src");
	return fs.existsSync(sourceDirectory) ? listSourceFiles(sourceDirectory) : [];
});
const compilerApi = new API({ cwd: rootDirectory });
const compilerSnapshot = compilerApi.updateSnapshot({
	openFiles: sourcePaths,
	openProjects: [path.join(rootDirectory, "tsconfig.json")],
});

try {
	for (const extensionPackage of activePackages) {
		checkPackageDependencies(extensionPackage);
		checkSourceImports(extensionPackage);
	}
} finally {
	compilerSnapshot.dispose();
	compilerApi.close();
}

if (failures.length > 0) {
	console.error("Extension boundary check failed:");
	for (const failure of failures) console.error(`- ${failure}`);
	process.exitCode = 1;
} else {
	console.log(
		`Extension boundary check passed: ${activePackages.length} active packages (${experimentalPackageCount} experimental) have no extension-to-extension dependencies.`,
	);
}

function findActiveExtensionPackages(directory) {
	const packages = [];

	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.name === "deprecated" || entry.name === "node_modules") {
			continue;
		}

		const entryPath = path.join(directory, entry.name);
		const packagePath = path.join(entryPath, "package.json");
		if (!fs.existsSync(packagePath)) {
			packages.push(...findActiveExtensionPackages(entryPath));
			continue;
		}

		const packageJson = readJson(packagePath);
		if (typeof packageJson.name !== "string") {
			throw new Error(`${relative(packagePath)} must define a package name.`);
		}

		packages.push({
			directory: entryPath,
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
		for (const specifier of moduleSpecifiers(sourcePath)) {
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
		if (entry.isFile() && isSourceFile(entry.name)) files.push(entryPath);
	}
	return files.sort();
}

function isSourceFile(fileName) {
	return SOURCE_FILE_SUFFIXES.some((suffix) => fileName.endsWith(suffix));
}

function moduleSpecifiers(sourcePath) {
	const project = compilerSnapshot.getDefaultProjectForFile(sourcePath);
	const sourceFile = project?.program.getSourceFile(sourcePath);
	if (!sourceFile) throw new Error(`TypeScript could not parse ${relative(sourcePath)}.`);
	const specifiers = [];

	const visit = (node) => {
		if (isImportDeclaration(node) || isExportDeclaration(node)) {
			const specifier = node.moduleSpecifier && stringLiteralText(node.moduleSpecifier);
			if (specifier) specifiers.push(specifier);
		} else if (isImportEqualsDeclaration(node)) {
			const reference = node.moduleReference;
			const specifier = isExternalModuleReference(reference)
				? stringLiteralText(reference.expression)
				: undefined;
			if (specifier) specifiers.push(specifier);
		} else if (isCallExpression(node)) {
			const firstArgument = node.arguments[0];
			const specifier = firstArgument && stringLiteralText(firstArgument);
			if (specifier && isModuleLoaderCall(node)) specifiers.push(specifier);
		}

		node.forEachChild(visit);
	};

	visit(sourceFile);
	return specifiers;
}

function isModuleLoaderCall(node) {
	return (
		node.expression.kind === SyntaxKind.ImportKeyword ||
		(isIdentifier(node.expression) && node.expression.text === "require")
	);
}

function stringLiteralText(node) {
	return isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node) ? node.text : undefined;
}

function isForbiddenExtensionReference(packageName, specifier) {
	if (specifier === packageName || specifier.startsWith(`${packageName}/`)) return false;
	return EXTENSION_PACKAGE_RE.test(specifier);
}

function readJson(filePath) {
	return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function relative(filePath) {
	return path.relative(rootDirectory, filePath) || filePath;
}
