import { ChatSession } from "../src/chat-session.js";
import { createIdentity } from "../src/identity.js";
import { HyperswarmTransport } from "../src/network.js";
import { createPrivateRoom } from "../src/protocol.js";

const [bootstrapJson, seedText, secretText] = process.argv.slice(2);
if (!bootstrapJson || !seedText || !secretText) {
  throw new Error("Missing network peer fixture args");
}
const bootstrap = JSON.parse(Buffer.from(bootstrapJson, "base64url").toString("utf8")) as unknown[];
const seed = Number.parseInt(seedText, 10);
const secret = Buffer.from(secretText, "base64url");
const identity = createIdentity(Buffer.alloc(32, seed));
const room = createPrivateRoom(secret);
const transport = new HyperswarmTransport({ room, identity, bootstrap, maxPeers: 8 });
const session = new ChatSession({
  room,
  identity,
  nickname: `Process${seed}`,
  transport,
  onChange: (snapshot) => {
    process.send?.({
      kind: "snapshot",
      peers: snapshot.participants.length,
      texts: snapshot.transcript.map(({ text }) => text),
    });
  },
});

process.on("message", (message: unknown) => {
  if (!message || typeof message !== "object") return;
  const command = Reflect.get(message, "command");
  if (command === "send") {
    const text = Reflect.get(message, "text");
    if (typeof text === "string") process.send?.({ kind: "sent", ...session.send(text) });
    return;
  }
  if (command === "stop") {
    void session.leave().finally(() => process.exit(0));
  }
});

try {
  await session.start();
  process.send?.({ kind: "ready" });
} catch (error) {
  process.send?.({
    kind: "error",
    message: error instanceof Error ? error.message : String(error),
  });
  await session.leave();
  process.exit(1);
}
