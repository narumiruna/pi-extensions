import { defaultDbusScreenSaverFactory } from "/smoke/build/dbus-inhibit.js";

const client = await defaultDbusScreenSaverFactory();
try {
  await client.inhibit("stale socket probe");
  throw new Error("Expected the stale D-Bus socket to reject inhibition");
} catch (error) {
  if (!(error instanceof Error)) throw error;
  process.stdout.write(`caught: ${error.message}\n`);
} finally {
  await client.close();
}
