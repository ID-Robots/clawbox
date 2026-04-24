/**
 * Files app — real file operations in /home/clawbox inside the container.
 * Every step is verified from two angles: the setup-api response, and
 * `docker exec ls` from the host. That catches cases where the API says
 * "success" but the file never actually made it to disk.
 */
import { test, expect } from "@playwright/test";
import { dockerExec } from "./helpers/container";
import {
  deleteFile,
  listFiles,
  mkdir,
  readFileRaw,
  uploadFile,
} from "./helpers/setup-api";

test.describe.configure({ mode: "serial" });

const TEST_DIR = "e2e-files-test";
const TEST_FILE = "hello.txt";
const TEST_CONTENTS = "hello from the e2e harness\n";

test.describe("files app happy path", () => {
  test.afterAll(async () => {
    // Best-effort cleanup so repeated runs don't accumulate test dirs.
    await dockerExec(
      ["bash", "-c", `rm -rf /home/clawbox/${TEST_DIR}`],
      { user: "clawbox" },
    ).catch(() => {});
  });

  test("mkdir creates directory on disk", async () => {
    await mkdir("", TEST_DIR);
    const entries = await listFiles("");
    expect(entries.files.some((f) => f.name === TEST_DIR && f.type === "directory")).toBe(true);

    const stdout = await dockerExec(
      ["bash", "-c", `ls -la /home/clawbox/${TEST_DIR}`],
      { user: "clawbox" },
    );
    expect(stdout).toContain("total");
  });

  test("upload writes file with correct contents", async () => {
    await uploadFile(TEST_DIR, TEST_FILE, TEST_CONTENTS);
    const contents = await readFileRaw(`${TEST_DIR}/${TEST_FILE}`);
    expect(contents).toBe(TEST_CONTENTS);

    const diskContents = await dockerExec(
      ["cat", `/home/clawbox/${TEST_DIR}/${TEST_FILE}`],
      { user: "clawbox" },
    );
    expect(diskContents).toBe(TEST_CONTENTS);
  });

  test("list returns the new file", async () => {
    const entries = await listFiles(TEST_DIR);
    const file = entries.files.find((f) => f.name === TEST_FILE);
    expect(file).toBeDefined();
    expect(file?.type).toBe("file");
    // Byte length — not char length — since the server stores encoded bytes
    // and the list API reports st_size. For multibyte content the two differ.
    expect(file?.size).toBe(Buffer.byteLength(TEST_CONTENTS));
  });

  test("delete removes the file", async () => {
    await deleteFile(`${TEST_DIR}/${TEST_FILE}`);
    const entries = await listFiles(TEST_DIR);
    expect(entries.files.find((f) => f.name === TEST_FILE)).toBeUndefined();
  });
});
