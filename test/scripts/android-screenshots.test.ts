import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const SCRIPT = "scripts/android-screenshots.sh";

function runAndroidScreenshots(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

describe("android screenshots script", () => {
  it("dry-runs with a normalized locale output path", () => {
    const result = runAndroidScreenshots(["--dry-run", "--locale", "pt-BR"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "apps/android/fastlane/metadata/android/pt-BR/images/phoneScreenshots",
    );
    expect(result.stdout).toContain(
      "apps/android/fastlane/metadata/android/pt-BR/images/wearScreenshots",
    );
    expect(result.stdout).toContain(".artifacts/android-screenshots/latest/phone");
    expect(result.stdout).toContain(".artifacts/android-screenshots/latest/wear");
    expect(result.stdout).toContain("Android screenshot size: 1440x2560");
    expect(result.stdout).toContain("Android screenshot size: 454x454");
    expect(result.stdout).toContain("Screenshot AVD: OpenClaw_Screenshots_API36");
    expect(result.stdout).toContain("Screenshot AVD: OpenClaw_Wear_Screenshots_API34");
    expect(result.stdout).toContain("Screenshot device profile: pixel_2");
    expect(result.stdout).toContain("Screenshot device profile: wearos_large_round");
    expect(result.stdout).toContain("Scenes: home chat settings gateway voice-wake");
    expect(result.stdout).toContain("Scenes: chat voice controls");
    expect(result.stdout).not.toContain("connect chat voice screen settings");
    expect(result.stdout).toContain("Dry run complete.");
  });

  it("keeps artifact cleanup inside the repository-owned evidence directory", () => {
    const result = runAndroidScreenshots(["--dry-run"], {
      ANDROID_SCREENSHOT_ARTIFACT_DIR: process.env.HOME,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(".artifacts/android-screenshots/latest");
    expect(result.stdout).not.toContain(`Android screenshot artifacts: ${process.env.HOME}\n`);
  });

  it.each(["../escape", "en/US", ".hidden", "en..US", ""])(
    "rejects locale path escapes before dry-run output: %j",
    (locale) => {
      const result = runAndroidScreenshots(["--dry-run", "--locale", locale]);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Invalid Android screenshot locale");
      expect(result.stderr).toContain("path separators and dot segments are not allowed");
      expect(result.stdout).not.toContain("Android screenshot output:");
    },
  );

  it("rejects screenshot dimensions outside Google Play's aspect-ratio limit", () => {
    const result = runAndroidScreenshots(["--dry-run"], {
      ANDROID_SCREENSHOT_SIZE: "1080x2424",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("does not meet Google Play dimension and aspect-ratio limits");
  });

  it("requires a form factor when selecting one emulator explicitly", () => {
    const result = runAndroidScreenshots(["--dry-run", "--avd", "custom"]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "--device and --avd require --form-factor phone or --form-factor wear",
    );
  });

  it("requires one form factor when retaining an emulator", () => {
    const result = runAndroidScreenshots(["--dry-run", "--keep-emulator"]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "--keep-emulator requires --form-factor phone or --form-factor wear",
    );
  });
});
