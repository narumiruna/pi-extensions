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
const SUPPORTED_EXTENSION_ENTRIES = new Set(["./src/index.ts", "./dist/index.ts"]);
const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
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
const rootPackage = readJson(path.join(rootDirectory, "package.json"));
const packagesDirectory = path.join(rootDirectory, "packages");
const workspacePackages = findWorkspacePackages(packagesDirectory);
const activePackages = workspacePackages.filter(({ packageJson }) => packageJson.pi?.extensions !== undefined);
const libraryPackages = workspacePackages.filter(({ packageJson }) => packageJson.pi?.extensions === undefined);
const libraryPackageNames = new Set(libraryPackages.map(({ name }) => name));
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
  checkRootPiManifest();
  for (const libraryPackage of libraryPackages) checkLibraryPackage(libraryPackage);
  for (const extensionPackage of activePackages) {
    checkPiEntrypoint(extensionPackage);
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
    `Extension boundary check passed: ${libraryPackages.length} libraries and ${activePackages.length} active extensions have valid package boundaries.`,
  );
}

function findWorkspacePackages(directory) {
  const packages = [];
  if (!fs.existsSync(directory)) return packages;

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "node_modules") {
      continue;
    }

    const entryPath = path.join(directory, entry.name);
    const packagePath = path.join(entryPath, "package.json");
    if (!fs.existsSync(packagePath)) {
      packages.push(...findWorkspacePackages(entryPath));
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

function checkRootPiManifest() {
  const expectedEntries = activePackages
    .map(
      ({ directory }) =>
        `./${relative(path.join(directory, "src", "index.ts"))
          .split(path.sep)
          .join("/")}`,
    )
    .sort();
  const actualEntries = rootPackage.pi?.extensions;
  if (!Array.isArray(actualEntries) || JSON.stringify([...actualEntries].sort()) !== JSON.stringify(expectedEntries)) {
    failures.push(
      `package.json pi.extensions must list every active package entrypoint: ${JSON.stringify(expectedEntries)}.`,
    );
  }
}

function checkLibraryPackage(libraryPackage) {
  if (!libraryPackage.packageJson.scripts?.build) {
    failures.push(`${relative(libraryPackage.packagePath)} libraries must define a build script.`);
  }
  if (!libraryPackage.packageJson.files?.includes("dist")) {
    failures.push(`${relative(libraryPackage.packagePath)} libraries must publish dist.`);
  }
  if (!String(libraryPackage.packageJson.main ?? "").startsWith("./dist/")) {
    failures.push(`${relative(libraryPackage.packagePath)} libraries must load JavaScript from dist.`);
  }
  if (!String(libraryPackage.packageJson.types ?? "").startsWith("./dist/")) {
    failures.push(`${relative(libraryPackage.packagePath)} libraries must load declarations from dist.`);
  }
}

function checkPiEntrypoint(extensionPackage) {
  const sourceDirectory = path.join(extensionPackage.directory, "src");
  const entrypoint = path.join(sourceDirectory, "index.ts");
  if (!fs.existsSync(entrypoint)) {
    failures.push(`${relative(entrypoint)} must exist as the Pi extension entrypoint.`);
  } else {
    const specifier = defaultExportForwarderSpecifier(entrypoint);
    if (!specifier) {
      failures.push(`${relative(entrypoint)} must forward its default export from a source module.`);
    } else {
      const target = path.resolve(path.dirname(entrypoint), specifier);
      const relativeTarget = path.relative(sourceDirectory, target);
      if (
        !specifier.startsWith("./") ||
        relativeTarget === ".." ||
        relativeTarget.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativeTarget)
      ) {
        failures.push(`${relative(entrypoint)} default export must stay inside its src directory.`);
      }
    }
  }

  const entries = extensionPackage.packageJson.pi?.extensions;
  const declaredEntry = Array.isArray(entries) && entries.length === 1 ? entries[0] : undefined;
  if (typeof declaredEntry !== "string" || !SUPPORTED_EXTENSION_ENTRIES.has(declaredEntry)) {
    failures.push(
      `${relative(extensionPackage.packagePath)} pi.extensions must be ["./src/index.ts"] or ["./dist/index.ts"].`,
    );
    return;
  }

  if (declaredEntry === "./src/index.ts") {
    if (!extensionPackage.packageJson.files?.includes("src")) {
      failures.push(`${relative(extensionPackage.packagePath)} source entrypoint must publish src.`);
    }
    return;
  }

  if (!extensionPackage.packageJson.files?.includes("dist")) {
    failures.push(`${relative(extensionPackage.packagePath)} dist entrypoint must publish dist.`);
  }
  if (!extensionPackage.packageJson.scripts?.build) {
    failures.push(`${relative(extensionPackage.packagePath)} dist entrypoint must define a build script.`);
  }
  const prepack = extensionPackage.packageJson.scripts?.prepack;
  if (typeof prepack !== "string" || !/(?:^|\s)npm run build(?:\s|$)/u.test(prepack)) {
    failures.push(`${relative(extensionPackage.packagePath)} dist entrypoint prepack must run the package build.`);
  }
}

function checkPackageDependencies(extensionPackage) {
  for (const field of DEPENDENCY_FIELDS) {
    const dependencies = extensionPackage.packageJson[field];
    if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) continue;

    for (const dependencyName of Object.keys(dependencies)) {
      if (!isForbiddenExtensionReference(extensionPackage.name, dependencyName)) continue;

      failures.push(`${relative(extensionPackage.packagePath)} ${field} must not reference ${dependencyName}.`);
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

function defaultExportForwarderSpecifier(sourcePath) {
  const project = compilerSnapshot.getDefaultProjectForFile(sourcePath);
  const sourceFile = project?.program.getSourceFile(sourcePath);
  if (!sourceFile) throw new Error(`TypeScript could not parse ${relative(sourcePath)}.`);

  for (const statement of sourceFile.statements) {
    if (
      !isExportDeclaration(statement) ||
      statement.exportClause?.kind !== SyntaxKind.NamedExports ||
      !statement.moduleSpecifier
    ) {
      continue;
    }
    if (statement.exportClause.elements.some((element) => element.name.text === "default")) {
      return stringLiteralText(statement.moduleSpecifier);
    }
  }
  return undefined;
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
      const specifier = isExternalModuleReference(reference) ? stringLiteralText(reference.expression) : undefined;
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
  for (const libraryPackageName of libraryPackageNames) {
    if (specifier === libraryPackageName || specifier.startsWith(`${libraryPackageName}/`)) {
      return false;
    }
  }
  return EXTENSION_PACKAGE_RE.test(specifier);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function relative(filePath) {
  return path.relative(rootDirectory, filePath) || filePath;
}
