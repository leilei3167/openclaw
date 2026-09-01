import { writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  projectNightClawerTelegramResult,
  projectNightClawerTelegramResultFile,
} from "../../scripts/mantis/project-night-clawer-telegram-result.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const nightClawerSha = "6d79fc7375bde19875f6b80de6b07a07219ce6b1";
const openclawSha = "a".repeat(40);

function completeResult() {
  return {
    schema: "openclaw-nightly-qa.h3-mantis-results.v1",
    nightClawerSha,
    openclawSha,
    status: "complete",
    tests: [
      {
        test: "telegram-restart-chain-x3",
        verdict: "PASS",
        mode: "NONE",
        gating: false,
      },
      { test: "telegram-status-truth", verdict: "PASS", mode: "NONE", gating: false },
    ],
  };
}

describe("Night Clawer Telegram result projection", () => {
  it("projects the exact successful result contract", () => {
    expect(
      projectNightClawerTelegramResult(completeResult(), { nightClawerSha, openclawSha }),
    ).toEqual(completeResult());
  });

  it.each([
    ["top-level field", { ...completeResult(), secret: "do not publish" }],
    [
      "test field",
      {
        ...completeResult(),
        tests: [{ ...completeResult().tests[0], detail: "private output" }],
      },
    ],
    [
      "extra test",
      { ...completeResult(), tests: [...completeResult().tests, completeResult().tests[0]] },
    ],
    ["wrong SHA", { ...completeResult(), nightClawerSha: "b".repeat(40) }],
  ])("rejects hostile %s output", (_label, value) => {
    expect(() =>
      projectNightClawerTelegramResult(value, { nightClawerSha, openclawSha }),
    ).toThrow();
  });

  it("accepts only allowlisted typed failures", () => {
    const failed = {
      schema: "openclaw-nightly-qa.h3-mantis-results.v1",
      nightClawerSha,
      openclawSha,
      status: "failed",
      failure: "FORUM_TOPIC_UNAVAILABLE",
      tests: [],
    };
    expect(projectNightClawerTelegramResult(failed, { nightClawerSha, openclawSha })).toEqual(
      failed,
    );
    expect(() =>
      projectNightClawerTelegramResult(
        { ...failed, failure: "private free-form failure" },
        { nightClawerSha, openclawSha },
      ),
    ).toThrow(/failure differs/u);
  });

  it("rejects an oversized file before parsing or publication", () => {
    const root = tempDirs.make("night-clawer-telegram-project-");
    const input = `${root}/input.json`;
    const output = `${root}/output.json`;
    writeFileSync(input, "x".repeat(16 * 1024 + 1));
    expect(() =>
      projectNightClawerTelegramResultFile({
        input,
        output,
        nightClawerSha,
        openclawSha,
      }),
    ).toThrow(/bounded regular file/u);
  });
});
