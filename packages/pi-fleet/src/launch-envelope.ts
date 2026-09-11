type FleetThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const FLEET_LAUNCH_ENV_KEYS = [
  "PI_FLEET_INVITE",
  "PI_FLEET_PARENT_SESSION_ID",
  "PI_FLEET_LAUNCH_ID",
  "PI_FLEET_KICKOFF_CAPABILITY",
  "PI_FLEET_CHILD_NAME",
  "PI_FLEET_ACCEPT_REQUESTS",
  "PI_FLEET_MODEL_PROVIDER",
  "PI_FLEET_MODEL_ID",
  "PI_FLEET_THINKING",
] as const;

export interface FleetLaunchEnvelope {
  invite: string;
  parentSessionId: string;
  launchId: string;
  kickoffCapability: string;
  childName?: string;
  acceptsRequests: boolean;
  model?: { provider: string; id: string; thinkingLevel?: FleetThinkingLevel };
}

const THINKING_LEVELS = new Set<FleetThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/u;

export function consumeLaunchEnvelope(environment: NodeJS.ProcessEnv = process.env): FleetLaunchEnvelope | undefined {
  const values = Object.fromEntries(FLEET_LAUNCH_ENV_KEYS.map((key) => [key, environment[key]]));
  for (const key of FLEET_LAUNCH_ENV_KEYS) delete environment[key];
  if (values.PI_FLEET_INVITE === undefined) {
    if (Object.values(values).some((value) => value !== undefined)) {
      throw new Error("Pi Fleet launch envelope is incomplete");
    }
    return undefined;
  }
  const invite = bounded(values.PI_FLEET_INVITE, "invite", 256);
  const parentSessionId = safeId(values.PI_FLEET_PARENT_SESSION_ID, "parent session id");
  const launchId = safeId(values.PI_FLEET_LAUNCH_ID, "launch id");
  const kickoffCapability = safeId(values.PI_FLEET_KICKOFF_CAPABILITY, "kickoff capability");
  const childName = optionalBounded(values.PI_FLEET_CHILD_NAME, "child name", 200);
  const acceptsRequests = parseBoolean(values.PI_FLEET_ACCEPT_REQUESTS);
  const provider = optionalBounded(values.PI_FLEET_MODEL_PROVIDER, "model provider", 200);
  const id = optionalBounded(values.PI_FLEET_MODEL_ID, "model id", 500);
  if ((provider === undefined) !== (id === undefined)) {
    throw new Error("Pi Fleet launch model identity is incomplete");
  }
  const thinking = values.PI_FLEET_THINKING;
  if (thinking !== undefined && (!provider || !id)) {
    throw new Error("Pi Fleet launch model identity is incomplete");
  }
  if (thinking !== undefined && !THINKING_LEVELS.has(thinking as FleetThinkingLevel)) {
    throw new Error("Pi Fleet launch thinking level is invalid");
  }
  return {
    invite,
    parentSessionId,
    launchId,
    kickoffCapability,
    ...(childName ? { childName } : {}),
    acceptsRequests,
    ...(provider && id
      ? {
          model: {
            provider,
            id,
            ...(thinking ? { thinkingLevel: thinking as FleetThinkingLevel } : {}),
          },
        }
      : {}),
  };
}

export function launchEnvelopeEnvironment(envelope: FleetLaunchEnvelope): Record<string, string> {
  return {
    PI_FLEET_INVITE: envelope.invite,
    PI_FLEET_PARENT_SESSION_ID: envelope.parentSessionId,
    PI_FLEET_LAUNCH_ID: envelope.launchId,
    PI_FLEET_KICKOFF_CAPABILITY: envelope.kickoffCapability,
    PI_FLEET_ACCEPT_REQUESTS: envelope.acceptsRequests ? "1" : "0",
    ...(envelope.childName ? { PI_FLEET_CHILD_NAME: envelope.childName } : {}),
    ...(envelope.model
      ? {
          PI_FLEET_MODEL_PROVIDER: envelope.model.provider,
          PI_FLEET_MODEL_ID: envelope.model.id,
          ...(envelope.model.thinkingLevel ? { PI_FLEET_THINKING: envelope.model.thinkingLevel } : {}),
        }
      : {}),
  };
}

function parseBoolean(value: string | undefined): boolean {
  if (value === undefined || value === "0") return false;
  if (value === "1") return true;
  throw new Error("Pi Fleet launch request policy is invalid");
}

function safeId(value: string | undefined, label: string): string {
  if (!value || !SAFE_ID.test(value)) throw new Error(`Pi Fleet launch ${label} is invalid`);
  return value;
}

function bounded(value: string | undefined, label: string, maxBytes: number): string {
  if (!value || value.includes("\0") || Buffer.byteLength(value) > maxBytes) {
    throw new Error(`Pi Fleet launch ${label} is invalid`);
  }
  return value;
}

function optionalBounded(value: string | undefined, label: string, maxBytes: number): string | undefined {
  return value === undefined ? undefined : bounded(value, label, maxBytes);
}
