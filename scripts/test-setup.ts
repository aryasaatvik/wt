// Keep normal offline tests independent of the user's wt and Git configuration.
import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const config = mkdtempSync(join(tmpdir(), "wt-test-config-"));
process.env.XDG_CONFIG_HOME = config;
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";
afterAll(() => rmSync(config, { recursive: true, force: true }));
