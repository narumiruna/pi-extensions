import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { validateSuite } from "./core.mjs";

const BENCHMARK_ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(BENCHMARK_ROOT, "../../..");
const DEFAULT_SUITE = path.join(BENCHMARK_ROOT, "suites", "pi-extensions.json");

export const DEFAULT_TIMEOUT_MS = 180_000;

export async function parseArguments(args) {
	const options = {
		cacheMode: "warm",
		cbmemBin:
			process.env.PI_CBMEM_BENCHMARK_BIN ??
			path.join(process.env.HOME ?? "", ".local", "bin", "codebase-memory-mcp"),
		extension: "npm:@narumitw/pi-cbmem",
		help: false,
		kind: "all",
		live: false,
		maxCostUsd: undefined,
		model: process.env.PI_CBMEM_BENCHMARK_MODEL,
		output: undefined,
		pi: process.env.PI_CBMEM_BENCHMARK_PI ?? "pi",
		project: undefined,
		repo: REPOSITORY_ROOT,
		runs: 1,
		suitePath: DEFAULT_SUITE,
		thinking: "off",
		timeoutMs: DEFAULT_TIMEOUT_MS,
	};

	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--help" || argument === "-h") options.help = true;
		else if (argument === "--live") options.live = true;
		else if (argument === "--cache-mode") {
			options.cacheMode = enumValue(args, ++index, argument, ["warm", "cold"]);
		} else if (argument === "--cbmem-bin") {
			options.cbmemBin = requireValue(args, ++index, argument);
		} else if (argument === "--extension") {
			options.extension = requireValue(args, ++index, argument);
		} else if (argument === "--kind") {
			options.kind = enumValue(args, ++index, argument, ["all", "exact-payload", "same-evidence"]);
		} else if (argument === "--max-cost-usd") {
			options.maxCostUsd = nonNegativeNumber(requireValue(args, ++index, argument), argument);
		} else if (argument === "--model") options.model = requireValue(args, ++index, argument);
		else if (argument === "--output") options.output = requireValue(args, ++index, argument);
		else if (argument === "--pi") options.pi = requireValue(args, ++index, argument);
		else if (argument === "--project") options.project = requireValue(args, ++index, argument);
		else if (argument === "--repo") options.repo = requireValue(args, ++index, argument);
		else if (argument === "--runs") {
			options.runs = positiveInteger(requireValue(args, ++index, argument), argument);
		} else if (argument === "--suite") {
			options.suitePath = requireValue(args, ++index, argument);
		} else if (argument === "--thinking") {
			options.thinking = enumValue(args, ++index, argument, [
				"off",
				"minimal",
				"low",
				"medium",
				"high",
				"xhigh",
				"max",
			]);
		} else if (argument === "--timeout-ms") {
			options.timeoutMs = positiveInteger(requireValue(args, ++index, argument), argument);
		} else throw new Error(`unknown argument: ${argument}`);
	}

	options.repo = path.resolve(options.repo);
	options.suitePath = path.resolve(options.suitePath);
	if (options.output) options.output = path.resolve(options.output);
	const suite = validateSuite(JSON.parse(await readFile(options.suitePath, "utf8")));
	options.suite = {
		...suite,
		tasks: suite.tasks.filter((task) => options.kind === "all" || task.kind === options.kind),
	};
	if (options.suite.tasks.length === 0) throw new Error("the selected suite has no matching tasks");
	if (options.live) {
		if (!options.model) throw new Error("--live requires --model <provider/model>");
		if (!options.project) throw new Error("--live requires --project <project-name>");
		if (options.maxCostUsd === undefined) {
			throw new Error("--live requires --max-cost-usd <amount>");
		}
	}
	return options;
}

export function printHelp() {
	process.stdout.write("Usage: just benchmark-cbmem [options]\n\n");
	process.stdout.write("Without --live, the command makes no provider request.\n\n");
	process.stdout.write("  --live                    Execute paired Pi subprocess trials.\n");
	process.stdout.write("  --model <provider/model>  Fixed model for both arms.\n");
	process.stdout.write("  --project <name>          Project name to fully rebuild and query.\n");
	process.stdout.write("  --repo <path>             Repository visible to both arms.\n");
	process.stdout.write("  --suite <path>            Versioned benchmark suite JSON.\n");
	process.stdout.write("  --kind <kind>             all, exact-payload, or same-evidence.\n");
	process.stdout.write("  --runs <count>            Trials per task and arm (default: 1).\n");
	process.stdout.write("  --cache-mode <mode>       warm or cold (default: warm).\n");
	process.stdout.write("  --thinking <level>        Fixed Pi thinking level (default: off).\n");
	process.stdout.write(
		"  --extension <source>      Treatment source (default: npm:@narumitw/pi-cbmem).\n",
	);
	process.stdout.write("  --max-cost-usd <amount>   Between-trial Pi-catalog cost guard.\n");
	process.stdout.write("  --timeout-ms <ms>         Index, tool, and trial deadline.\n");
	process.stdout.write("  --output <path>           Atomically write the JSON result.\n");
	process.stdout.write("  --pi <path>               Pi executable (default: pi).\n");
	process.stdout.write("  --cbmem-bin <path>        Codebase Memory CLI path.\n");
	process.stdout.write("  -h, --help                Show this help.\n");
}

function requireValue(args, index, option) {
	const value = args[index];
	if (!value) throw new Error(`${option} requires a value`);
	return value;
}

function positiveInteger(value, option) {
	const number = Number(value);
	if (!Number.isSafeInteger(number) || number <= 0) {
		throw new Error(`${option} must be a positive integer`);
	}
	return number;
}

function nonNegativeNumber(value, option) {
	const number = Number(value);
	if (!Number.isFinite(number) || number < 0) {
		throw new Error(`${option} must be a non-negative number`);
	}
	return number;
}

function enumValue(args, index, option, values) {
	const value = requireValue(args, index, option);
	if (!values.includes(value)) throw new Error(`${option} must be one of: ${values.join(", ")}`);
	return value;
}
