const MAX_EVENT_LINE_BYTES = 256 * 1024;

/** Frame RPC output by LF bytes before strict UTF-8 decoding, so one bad line cannot lose later events. */
export class JsonLineDecoder {
  private fragments: Buffer[] = [];
  private bytes = 0;
  private dropping = false;
  private readonly decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

  constructor(
    private readonly onValue: (value: unknown) => void,
    private readonly onMalformed: () => void,
  ) {}

  push(chunk: Buffer | string): void {
    const data = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    let offset = 0;
    while (offset < data.length) {
      const newline = data.indexOf(0x0a, offset);
      const end = newline < 0 ? data.length : newline;
      const fragment = data.subarray(offset, end);
      if (!this.dropping) {
        if (this.bytes + fragment.length > MAX_EVENT_LINE_BYTES) {
          this.clear();
          this.dropping = true;
          this.onMalformed();
        } else if (fragment.length > 0) {
          // Copy only the bounded partial frame, not its possibly much larger source chunk.
          this.fragments.push(Buffer.from(fragment));
          this.bytes += fragment.length;
        }
      }
      if (newline < 0) return;
      this.complete();
      offset = newline + 1;
    }
  }

  finish(): void {
    this.complete();
  }

  private complete(): void {
    const dropping = this.dropping;
    const line = Buffer.concat(this.fragments, this.bytes);
    this.clear();
    this.dropping = false;
    if (dropping || line.length === 0) return;
    try {
      const text = this.decoder.decode(line);
      if (text.trim()) this.onValue(JSON.parse(text));
    } catch {
      this.onMalformed();
    }
  }

  private clear(): void {
    this.fragments = [];
    this.bytes = 0;
  }
}
