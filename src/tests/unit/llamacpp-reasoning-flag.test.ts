import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

/**
 * Gemma 4's chat template turns thinking ON, and the launch script passed no
 * --reasoning flag — so production paid for it without ever choosing it.
 *
 * Measured on an Orin Nano, same question, same answer ("Paris"):
 *   off   194ms, 0 reasoning chars
 *   on   3576ms, 440
 *   auto 2932ms, 346   <- what production was silently doing
 *
 * It is a real trade, not free: thinking ON is the only way this model gets
 * weekday arithmetic right. So the point of these tests is that the choice
 * stays visible and overridable, never that "off" is correct forever.
 */
const SCRIPT = path.join(process.cwd(), "scripts", "start-llamacpp.sh");
const INSTALL = path.join(process.cwd(), "install.sh");
const src = fs.readFileSync(SCRIPT, "utf8");

describe("the local model's reasoning setting", () => {
  it("is passed to llama-server rather than left to the template", () => {
    expect(src).toMatch(/--reasoning "\$LLAMACPP_REASONING"/);
  });

  it("is overridable from the environment", () => {
    expect(src).toMatch(/LLAMACPP_REASONING="\$\{LLAMACPP_REASONING:-\w+\}"/);
  });

  it("accepts only the three values llama-server understands", () => {
    // `--reasoning` takes on|off|auto — it is not the 8-level effort scale the
    // cloud providers expose, and passing anything else makes llama-server exit.
    const block = src.slice(src.indexOf("LLAMACPP_REASONING="));
    expect(block).toMatch(/on\|off\|auto\)/);
  });

  it("falls back to a valid value instead of failing to start", () => {
    // A typo in .env must not leave the device with no local model at all.
    const block = src.slice(src.indexOf("LLAMACPP_REASONING="));
    expect(block).toMatch(/Invalid LLAMACPP_REASONING/);
    expect(block).toMatch(/LLAMACPP_REASONING=off/);
  });

  it("says which mode it started in", () => {
    // Otherwise the only symptom of the wrong setting is that replies feel slow.
    expect(src).toMatch(/reasoning=\$\{LLAMACPP_REASONING\}/);
  });

  it("is written into .env at install so it can be found and changed", () => {
    const install = fs.readFileSync(INSTALL, "utf8");
    expect(install).toMatch(/ensure_env_setting "\$ENV_FILE" "LLAMACPP_REASONING"/);
  });
});
