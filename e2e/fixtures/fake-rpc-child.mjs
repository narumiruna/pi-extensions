import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

const mode = process.argv[2];
let buffer = "";
const decoder = new StringDecoder("utf8");
const requests = [];
let descendant;

if (mode === "descendant") {
	descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
		stdio: "ignore",
	});
}

process.stdin.on("data", (chunk) => {
	buffer += decoder.write(chunk);
	while (true) {
		const newline = buffer.indexOf("\n");
		if (newline < 0) break;
		let line = buffer.slice(0, newline);
		buffer = buffer.slice(newline + 1);
		if (line.endsWith("\r")) line = line.slice(0, -1);
		if (!line) continue;
		handle(JSON.parse(line));
	}
});

process.stdin.on("end", () => {
	buffer += decoder.end();
	if (mode !== "hang" && mode !== "descendant") process.exit(0);
});

function respond(record) {
	process.stdout.write(`${JSON.stringify(record)}\n`);
}

function handle(request) {
	if (mode === "correlate") {
		requests.push(request);
		if (requests.length === 2) {
			for (const item of [...requests].reverse()) {
				respond({
					type: "response",
					id: item.id,
					command: item.type,
					success: true,
				});
			}
		}
		return;
	}
	if (mode === "fail") {
		process.stderr.write(`${"fixture failure ".repeat(2_000)}\n`);
		process.exit(7);
	}
	if (mode === "descendant") {
		respond({
			type: "response",
			id: request.id,
			command: request.type,
			success: true,
			data: { pid: descendant.pid },
		});
	}
}

setInterval(() => {}, 1_000);
