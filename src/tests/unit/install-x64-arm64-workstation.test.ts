import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Runs bash: vitest's 5 s default is not enough on a loaded CI runner
// (src/tests/unit/test-timeout-hygiene.test.ts).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * install-x64.sh is the installer for PCs: a desktop Ubuntu host with its own
 * login user, as opposed to the Jetson appliance install.sh builds. NVIDIA's
 * DGX Spark (and partner builds of it, such as Gigabyte's AI TOP Atom) is
 * exactly such a PC — Ubuntu 24.04 desktop, a normal user, an NVIDIA GPU — but
 * it is arm64, and the installer refused it on its first line.
 */
const INSTALLER = path.resolve(process.cwd(), "install-x64.sh");
const SOURCE = readFileSync(INSTALLER, "utf8");

function sliceFunction(name: string): string {
  const start = SOURCE.indexOf(`\n${name}() {`);
  if (start < 0) throw new Error(`${name}() not found in install-x64.sh`);
  const end = SOURCE.indexOf("\n}\n", start + 1);
  if (end < 0) throw new Error(`end of ${name}() not found`);
  return SOURCE.slice(start + 1, end + 3);
}

let dir: string;
let bin: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "clawbox-x64-arm64-"));
  bin = path.join(dir, "bin");
  mkdirSync(bin);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function stub(name: string, body: string): string {
  const file = path.join(bin, name);
  writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

function runBash(script: string, env: Record<string, string> = {}) {
  const r = spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, ...env },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe("install-x64.sh on an arm64 workstation (DGX Spark)", () => {
  it("lets an arm64 host that is not a Jetson past the architecture gate", () => {
    // The script's own opening, up to where it starts resolving the install
    // user, run as "root" on an aarch64 machine.
    const marker = "# `logname` fails in containers";
    const end = SOURCE.indexOf(marker);
    expect(end).toBeGreaterThan(0);
    stub("id", 'if [ "${1:-}" = "-u" ]; then echo 0; else /usr/bin/id "$@"; fi');
    stub("uname", 'if [ "${1:-}" = "-m" ]; then echo aarch64; else /usr/bin/uname "$@"; fi');
    const r = runBash(`${SOURCE.slice(0, end)}\necho "GATE_PASSED arch=\${HOST_ARCH:-unset}"\n`);
    expect(r.out).toContain("GATE_PASSED arch=aarch64");
    expect(r.status).toBe(0);
  });

  it("still sends a Jetson to install.sh, and refuses an architecture it cannot serve", () => {
    const fn = sliceFunction("host_arch_or_refuse");
    const tegra = path.join(dir, "nv_tegra_release");
    writeFileSync(tegra, "# R36 (release), REVISION: 4.3\n");

    const jetson = runBash(`${fn}\nhost_arch_or_refuse aarch64 "${tegra}"`);
    expect(jetson.status).not.toBe(0);
    expect(jetson.out).toMatch(/Jetson.*install\.sh/);

    const spark = runBash(`${fn}\nhost_arch_or_refuse aarch64 "${path.join(dir, "absent")}"`);
    expect(spark.status).toBe(0);
    expect(spark.out.trim()).toBe("aarch64");

    const pc = runBash(`${fn}\nhost_arch_or_refuse x86_64 "${tegra}"`);
    expect(pc.status).toBe(0);
    expect(pc.out.trim()).toBe("x86_64");

    const riscv = runBash(`${fn}\nhost_arch_or_refuse riscv64 "${path.join(dir, "absent")}"`);
    expect(riscv.status).not.toBe(0);
    expect(riscv.out).toContain("riscv64");
  });

  it("downloads the isolated Node fallback for the host's architecture, not always x64", () => {
    // nodejs.org names the tarballs linux-x64 and linux-arm64; an x64 tarball
    // unpacked on arm64 leaves a node that cannot exec.
    expect(SOURCE).not.toContain("-linux-x64.tar.xz");
    expect(SOURCE).not.toMatch(/\/opt\/clawbox\/node-v\$\{NODE_DIST_VERSION\}-linux-x64"/);
    const fn = sliceFunction("node_dist_arch");
    expect(runBash(`${fn}\nnode_dist_arch x86_64`).out.trim()).toBe("x64");
    expect(runBash(`${fn}\nnode_dist_arch aarch64`).out.trim()).toBe("arm64");
  });

  it("skips Google Chrome on arm64 without touching apt, like install.sh does", () => {
    // Google ships Chrome for Linux on amd64 only: on arm64 the step would add
    // an amd64-only apt source and fail the install it guards.
    stub("uname", 'if [ "${1:-}" = "-m" ]; then echo aarch64; else /usr/bin/uname "$@"; fi');
    const calls = path.join(dir, "calls");
    stub("curl", `echo "curl $*" >> "${calls}"; exit 1`);
    stub("apt-get", `echo "apt-get $*" >> "${calls}"; exit 1`);
    const r = runBash([
      "google_chrome_installed() { return 1; }",
      sliceFunction("step_google_chrome_install"),
      "step_google_chrome_install; echo rc=$?",
    ].join("\n"));
    expect(r.out).toContain("rc=0");
    expect(r.out).toMatch(/amd64 only/);
    let touched = "";
    try { touched = readFileSync(calls, "utf8"); } catch { /* nothing was called */ }
    expect(touched).toBe("");
  });

  describe("llama.cpp is built for the GPU the host has", () => {
    // `llamacpp_cmake_args` asks `command -v nvcc` before the candidate list, so
    // a CUDA machine running these tests (the hardware this is for) would answer
    // with its own /usr/bin/nvcc. Each script hides that lookup.
    const HIDE_HOST_NVCC =
      'command() { if [ "$1" = "-v" ] && [ "$2" = "nvcc" ]; then return 1; fi; builtin command "$@"; }';

    it("finds nvcc where NVIDIA installs it, off every root and systemd PATH", () => {
      // The Jetson installer learned this in install.sh::step_llamacpp_install;
      // this copy kept `command -v nvcc` alone and built a CPU-only server.
      const nvcc = stub("nvcc-real", "echo 'Cuda compilation tools, release 13.0'");
      stub("nvidia-smi", "echo '12.1'");
      const r = runBash([
        HIDE_HOST_NVCC,
        `LLAMACPP_NVCC_CANDIDATES=("${nvcc}")`,
        sliceFunction("llamacpp_cmake_args"),
        "llamacpp_cmake_args",
      ].join("\n"));
      expect(r.status).toBe(0);
      expect(r.out).toContain("-DGGML_CUDA=ON");
      expect(r.out).toContain(`-DCMAKE_CUDA_COMPILER=${nvcc}`);
    });

    it("targets GB10's own architecture (sm_121a), as NVIDIA's DGX Spark llama.cpp playbook does", () => {
      const nvcc = stub("nvcc-real", "true");
      stub("nvidia-smi", "echo '12.1'");
      const r = runBash([
        HIDE_HOST_NVCC,
        `LLAMACPP_NVCC_CANDIDATES=("${nvcc}")`,
        sliceFunction("llamacpp_cmake_args"),
        "llamacpp_cmake_args",
      ].join("\n"));
      expect(r.out).toContain("-DCMAKE_CUDA_ARCHITECTURES=121a-real");
    });

    it("leaves other GPUs on llama.cpp's own architecture list", () => {
      const nvcc = stub("nvcc-real", "true");
      stub("nvidia-smi", "echo '8.9'");
      const r = runBash([
        HIDE_HOST_NVCC,
        `LLAMACPP_NVCC_CANDIDATES=("${nvcc}")`,
        sliceFunction("llamacpp_cmake_args"),
        "llamacpp_cmake_args",
      ].join("\n"));
      expect(r.out).toContain("-DGGML_CUDA=ON");
      expect(r.out).not.toContain("CMAKE_CUDA_ARCHITECTURES");
    });

    it("builds for the CPU when there is no CUDA compiler at all", () => {
      const r = runBash([
        HIDE_HOST_NVCC,
        `LLAMACPP_NVCC_CANDIDATES=("${path.join(dir, "no-such-nvcc")}")`,
        sliceFunction("llamacpp_cmake_args"),
        "llamacpp_cmake_args",
      ].join("\n"));
      expect(r.status).toBe(0);
      expect(r.out.trim()).toBe("-DCMAKE_BUILD_TYPE=Release");
    });

    it("builds the pinned llama.cpp, in a directory of ClawBox's own", () => {
      // Unpinned HEAD, or whatever ~/llama.cpp held, could be a build without
      // the speculative decoding .env asks for. And ~/llama.cpp is where NVIDIA's
      // DGX Spark playbook builds the owner's OWN llama.cpp: the step must not
      // reconfigure that tree (it deletes the CMake cache before configuring).
      const step = sliceFunction("step_llamacpp_install");
      const pin = /LLAMACPP_COMMIT="\$\{LLAMACPP_COMMIT:-([0-9a-f]{40})\}"/.exec(step);
      expect(pin, "a full-SHA default pin").not.toBeNull();
      expect(step).toMatch(/git fetch --quiet --depth 1 origin \$LLAMACPP_COMMIT && git checkout --quiet \$LLAMACPP_COMMIT/);
      expect(step).not.toContain('local LLAMA_DIR="$CLAWBOX_HOME/llama.cpp"');
      expect(step).toContain('local LLAMA_DIR="$CLAWBOX_HOME/.local/share/clawbox/llama.cpp"');
    });

    it("takes only a commit hash as the pin, and the directory as one quoted word", () => {
      // Both reach a `bash -lc` string run as the owner: an override with a
      // space or a `;` in it would be split, or run, instead of reaching git.
      const step = sliceFunction("step_llamacpp_install");
      const check = /if ! \[\[ "\$LLAMACPP_COMMIT" =~ (\^\[0-9a-f\]\{7,40\}\$) \]\]/.exec(step);
      expect(check, "a hex-only check on LLAMACPP_COMMIT").not.toBeNull();
      const valid = (v: string) => runBash(`[[ "${v}" =~ ^[0-9a-f]{7,40}$ ]] && echo yes || echo no`).out.trim();
      expect(valid("29c720eaf72fcf8e4e61a56a88b994d92668261d")).toBe("yes");
      expect(valid("main; touch /tmp/x")).toBe("no");
      for (const line of step.split("\n").filter((l) => l.includes("as_user_login"))) {
        expect(line).not.toMatch(/\$LLAMA_DIR\b/);
      }
      expect(step).toContain(`LLAMA_DIR_Q="$(printf '%q' "$LLAMA_DIR")"`);
    });

    it("uses that decision in the build step instead of `command -v nvcc`", () => {
      const step = sliceFunction("step_llamacpp_install");
      expect(step).toContain("llamacpp_cmake_args");
      expect(step).not.toMatch(/if command -v nvcc/);
    });
  });

  describe("the Wi-Fi interface the app is pointed at", () => {
    // src/lib/network.ts defaults NETWORK_INTERFACE to the Jetson's wlP1p1s0
    // and, finding no such device, reports `interface_mismatch` — "the fix is
    // to point NETWORK_INTERFACE at one of them". install-x64.sh never did, so
    // every Wi-Fi PC (wlP9s9 on a DGX Spark, wlp2s0 on a laptop) carried the
    // error into Settings and the agent's wifi_status tool.
    function seed(nmcliOut: string, envBody = "") {
      stub("nmcli", `printf '%s\\n' ${nmcliOut.split("\n").map((l) => `'${l}'`).join(" ")}`);
      const envFile = path.join(dir, ".env");
      writeFileSync(envFile, envBody);
      const r = runBash([
        sliceFunction("ensure_env_setting"),
        sliceFunction("seed_network_interface"),
        `seed_network_interface "${envFile}"`,
      ].join("\n"));
      return { r, env: readFileSync(envFile, "utf8") };
    }

    it("names the machine's own Wi-Fi device", () => {
      const { env } = seed("enP7s7:ethernet\nwlP9s9:wifi\np2p-dev-wlP9s9:wifi-p2p\nlo:loopback");
      expect(env).toMatch(/^NETWORK_INTERFACE=wlP9s9$/m);
    });

    it("leaves .env alone on a machine with no Wi-Fi, and keeps an operator's choice", () => {
      expect(seed("eth0:ethernet\nlo:loopback").env).not.toContain("NETWORK_INTERFACE");
      const kept = seed("wlP9s9:wifi", "NETWORK_INTERFACE=wlan7\n").env;
      expect(kept).toMatch(/^NETWORK_INTERFACE=wlan7$/m);
      expect(kept).not.toContain("wlP9s9");
    });

    it("is part of the .env seeding", () => {
      expect(sliceFunction("step_directories_permissions")).toContain('seed_network_interface "$ENV_FILE"');
    });
  });
});

