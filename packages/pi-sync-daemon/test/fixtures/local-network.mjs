import net from "node:net";

const marker = Symbol.for("pi-sync-test-local-network");
if (!net.Socket.prototype[marker]) {
  Object.defineProperty(net.Socket.prototype, marker, { value: true });
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    let options = args[0];
    if (Array.isArray(options)) options = options[0];
    const localPath =
      typeof options === "string" || (options && typeof options === "object" && typeof options.path === "string");
    const host =
      options && typeof options === "object"
        ? (options.host ?? "localhost")
        : typeof args[1] === "string"
          ? args[1]
          : "localhost";
    if (!localPath && !["127.0.0.1", "localhost", "::1"].includes(host))
      throw new Error(`Fixture refused non-loopback network access: ${host}`);
    return Reflect.apply(connect, this, args);
  };
}
