import { dirname, join } from "node:path";

/**
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {[command: string, args: string[]]}
 */
export function npmInvocation(args, env = process.env) {
  const cli =
    env.npm_execpath ||
    (process.platform === "win32" ? join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js") : undefined);
  return cli ? [process.execPath, [cli, ...args]] : ["npm", args];
}
