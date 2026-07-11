import { StringDecoder } from "node:string_decoder";

const DEFAULT_MAX_LINE_BYTES = 256 * 1024;

export interface JsonLineDecoderOptions {
	maxLineBytes?: number;
	onValue: (value: unknown) => void;
	onMalformed?: (line: string) => void;
	onOversized?: (bytes: number) => void;
}

/** Bounded newline-delimited JSON decoder for child Pi event streams. */
export class JsonLineDecoder {
	private buffer = "";
	private droppingOversizedLine = false;
	private readonly maxLineBytes: number;
	private readonly decoder = new StringDecoder("utf8");

	constructor(private readonly options: JsonLineDecoderOptions) {
		const maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
		if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1) {
			throw new Error("JSON line limit must be a positive safe integer");
		}
		this.maxLineBytes = maxLineBytes;
	}

	push(chunk: string | Buffer): void {
		this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
		this.drain(false);
	}

	finish(): void {
		this.buffer += this.decoder.end();
		this.drain(true);
		this.buffer = "";
		this.droppingOversizedLine = false;
	}

	private drain(flush: boolean): void {
		while (true) {
			const newline = this.buffer.indexOf("\n");
			if (newline < 0) break;
			const line = this.buffer.slice(0, newline).replace(/\r$/, "");
			this.buffer = this.buffer.slice(newline + 1);
			if (this.droppingOversizedLine) {
				this.droppingOversizedLine = false;
				continue;
			}
			this.processLine(line);
		}

		if (!flush && Buffer.byteLength(this.buffer, "utf8") > this.maxLineBytes) {
			this.options.onOversized?.(Buffer.byteLength(this.buffer, "utf8"));
			this.buffer = "";
			this.droppingOversizedLine = true;
		}

		if (flush && this.buffer.length > 0 && !this.droppingOversizedLine) {
			this.processLine(this.buffer.replace(/\r$/, ""));
		}
	}

	private processLine(line: string): void {
		if (!line.trim()) return;
		const bytes = Buffer.byteLength(line, "utf8");
		if (bytes > this.maxLineBytes) {
			this.options.onOversized?.(bytes);
			return;
		}
		try {
			this.options.onValue(JSON.parse(line));
		} catch {
			this.options.onMalformed?.(line);
		}
	}
}
