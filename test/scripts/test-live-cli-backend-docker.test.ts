// Test Live Cli Backend Docker tests cover test live cli backend docker script behavior.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT_PATH = path.resolve(
  import.meta.dirname,
  "../../scripts/test-live-cli-backend-docker.sh",
);

describe("scripts/test-live-cli-backend-docker.sh", () => {
  it("rejects invalid setup timeout values before metadata or Docker setup", () => {
    const result = spawnSync("bash", [SCRIPT_PATH], {
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_LIVE_CLI_BACKEND_SETUP_TIMEOUT_SECONDS: "180s",
      },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      "invalid OPENCLAW_LIVE_CLI_BACKEND_SETUP_TIMEOUT_SECONDS: 180s",
    );
    expect(result.stderr).not.toContain("Cannot find package 'tsx'");
    expect(result.stderr).not.toContain("docker");
  });
});
