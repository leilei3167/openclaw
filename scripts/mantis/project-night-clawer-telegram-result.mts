import {
  constants,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const INPUT_MAX_BYTES = 16 * 1024;
const SCHEMA = "openclaw-nightly-qa.h3-mantis-results.v1";
const TEST_IDS = ["telegram-restart-chain-x3", "telegram-status-truth"] as const;
const VERDICTS = new Set(["HARD_FAIL", "INFRA", "PASS", "SOFT"]);
const MODES = new Set([
  "CREDENTIAL_UNAVAILABLE",
  "DRIVER_DETERMINISTIC_FAULT",
  "FRESH_AUTH_REQUIRED",
  "LIVE_LANE_VARIANCE",
  "NONE",
]);
const FAILURES = new Set([
  "BOT_ID_INVALID",
  "CHILD_OUTPUT_LIMIT",
  "CHILD_TIMEOUT",
  "CONTROLLER_ABORTED",
  "CREDENTIAL_LEASE_LOST",
  "DRIVER_ID_INVALID",
  "FORUM_CHAT_INVALID",
  "FORUM_GROUP_ID_INVALID",
  "FORUM_MEMBER_INVALID",
  "FORUM_TOPIC_ID_INVALID",
  "FORUM_TOPIC_NAME_INVALID",
  "FORUM_TOPIC_PERMISSION_MISSING",
  "FORUM_TOPIC_UNAVAILABLE",
  "H3_DRIVER_READY_TIMEOUT",
  "H3_EXITED_BEFORE_DRIVER_READY",
  "H3_LIVE_RESULT_FAILED",
  "H3_RESULT_IDS_INVALID",
  "H3_RESULT_INVENTORY_INVALID",
  "H3_RESULT_INVALID",
  "H3_SUT_FAILED",
  "H3_SUT_TIMEOUT",
  "MANTIS_CLEANUP_FAILED",
  "MANTIS_CONTROLLER_FAILED",
  "RESTART_DRIVER_CRASHED",
  "SKILL_PATH_INVALID",
  "STATUS_DRIVER_CRASHED",
  "TDLIB_DOCTOR_FAILED",
  "TDLIB_LIBRARY_INVALID",
  "TELEGRAM_API_CREATEFORUMTOPIC_REJECTED",
  "TELEGRAM_API_DELETEFORUMTOPIC_REJECTED",
  "TELEGRAM_API_GETCHATMEMBER_REJECTED",
  "TELEGRAM_API_GETCHAT_REJECTED",
  "TELEGRAM_API_RESPONSE_INVALID",
  "TELEGRAM_API_RESPONSE_LIMIT",
  "TELEGRAM_IDENTITIES_COLLIDE",
]);

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string) {
  const actual = Object.keys(value).toSorted((left, right) => left.localeCompare(right));
  const expected = [...allowed].toSorted((left, right) => left.localeCompare(right));
  if (actual.join("\n") !== expected.join("\n")) {
    throw new Error(`${label} fields differ`);
  }
}

function sha(value: unknown, expected: string, label: string) {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/u.test(value) || value !== expected) {
    throw new Error(`${label} differs`);
  }
  return value;
}

function projectRow(value: unknown) {
  const row = object(value, "test result");
  const hasStatus = Object.hasOwn(row, "status");
  exactKeys(
    row,
    hasStatus
      ? ["gating", "mode", "status", "test", "verdict"]
      : ["gating", "mode", "test", "verdict"],
    "test result",
  );
  if (!TEST_IDS.includes(row.test as (typeof TEST_IDS)[number])) {
    throw new Error("test result id differs");
  }
  if (!VERDICTS.has(String(row.verdict))) {
    throw new Error("test result verdict differs");
  }
  if (!MODES.has(String(row.mode))) {
    throw new Error("test result mode differs");
  }
  if (typeof row.gating !== "boolean") {
    throw new Error("test result gating differs");
  }
  if (hasStatus && row.status !== "BLOCKED") {
    throw new Error("test result status differs");
  }
  return {
    test: row.test,
    verdict: row.verdict,
    mode: row.mode,
    gating: row.gating,
    ...(hasStatus ? { status: "BLOCKED" } : {}),
  };
}

export function projectNightClawerTelegramResult(
  value: unknown,
  expected: { nightClawerSha: string; openclawSha: string },
) {
  const root = object(value, "result");
  if (root.status !== "complete" && root.status !== "failed") {
    throw new Error("result status differs");
  }
  const failed = root.status === "failed";
  exactKeys(
    root,
    failed
      ? ["failure", "nightClawerSha", "openclawSha", "schema", "status", "tests"]
      : ["nightClawerSha", "openclawSha", "schema", "status", "tests"],
    "result",
  );
  if (root.schema !== SCHEMA) {
    throw new Error("result schema differs");
  }
  const nightClawerSha = sha(root.nightClawerSha, expected.nightClawerSha, "Night Clawer SHA");
  const openclawSha = sha(root.openclawSha, expected.openclawSha, "OpenClaw SHA");
  if (failed && !FAILURES.has(String(root.failure))) {
    throw new Error("result failure differs");
  }
  if (!Array.isArray(root.tests) || root.tests.length > TEST_IDS.length) {
    throw new Error("result test inventory differs");
  }
  const tests = root.tests.map(projectRow);
  const ids = tests
    .map((row) => row.test)
    .toSorted((left, right) => String(left).localeCompare(String(right)));
  const expectedIds =
    failed && tests.length === 0
      ? []
      : [...TEST_IDS].toSorted((left, right) => left.localeCompare(right));
  if (ids.join("\n") !== expectedIds.join("\n")) {
    throw new Error("result test ids differ");
  }
  return {
    schema: SCHEMA,
    nightClawerSha,
    openclawSha,
    status: root.status,
    ...(failed ? { failure: root.failure } : {}),
    tests,
  };
}

export function projectNightClawerTelegramResultFile(params: {
  input: string;
  output: string;
  nightClawerSha: string;
  openclawSha: string;
}) {
  const input = path.resolve(params.input);
  const output = path.resolve(params.output);
  const info = lstatSync(input);
  if (!info.isFile() || info.isSymbolicLink() || info.size > INPUT_MAX_BYTES) {
    throw new Error("controller result file is not a bounded regular file");
  }
  const value = JSON.parse(readFileSync(input, "utf8"));
  const projected = projectNightClawerTelegramResult(value, {
    nightClawerSha: params.nightClawerSha,
    openclawSha: params.openclawSha,
  });
  mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  const fd = openSync(
    output,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, `${JSON.stringify(projected, null, 2)}\n`, "utf8");
  } finally {
    closeSync(fd);
  }
  return projected;
}

function parseArgs(argv: string[]) {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || values.has(key)) {
      throw new Error("invalid arguments");
    }
    values.set(key, value);
  }
  const required = ["--input", "--night-clawer-sha", "--openclaw-sha", "--output"];
  if (values.size !== required.length || required.some((key) => !values.has(key))) {
    throw new Error("invalid arguments");
  }
  return {
    input: values.get("--input")!,
    nightClawerSha: values.get("--night-clawer-sha")!,
    openclawSha: values.get("--openclaw-sha")!,
    output: values.get("--output")!,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  projectNightClawerTelegramResultFile(parseArgs(process.argv.slice(2)));
}
