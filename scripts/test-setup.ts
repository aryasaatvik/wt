// Keep normal offline tests independent of the user's wt and Git configuration.
import { afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const config = mkdtempSync(join(tmpdir(), "wt-test-config-"));
process.env.XDG_CONFIG_HOME = config;
// Removal tests must never scan or delete the real ~/Library/Developer; Xcode
// tests opt back in with a fixture library root.
mkdirSync(join(config, "wt"));
writeFileSync(join(config, "wt", "config.toml"), "[remove]\nxcode = false\n");
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";
afterAll(() => rmSync(config, { recursive: true, force: true }));
