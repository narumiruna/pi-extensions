export type { ConnectionOptions } from "./client.js";
export {
  DaemonConnection,
  DaemonError,
  ensureDaemon,
  findDaemon,
  requestDaemon,
  stopDaemon,
  waitForDaemonExit,
} from "./client.js";
export type { DocumentView } from "./document.js";
export { documentFingerprint } from "./document.js";
export type { EngineContext, EngineHost, EngineSession, ReviewRequest } from "./engine/host.js";
export { modelSignature } from "./model-signature.js";
export type {
  Callback,
  ClientContact as ContactState,
  ClientEvent,
  ClientFacts,
  ClientHandoff,
  Identity,
  JobView,
  RemoteError,
} from "./protocol.js";
export { MAX_SETTINGS_BYTES, PROTOCOL_VERSION } from "./protocol.js";
