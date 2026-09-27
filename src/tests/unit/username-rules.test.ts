import { describe, expect, it } from "vitest";
import { checkUsername, RESERVED_USERNAMES, USERNAME_RE } from "@/lib/username-rules";
import { assertCreatable, userAddRecord, UserAdminError } from "@/lib/clawbox-users";

// TASK-1256: every ClawBox user is a real Linux account, so the name reaching
// useradd must match the strict [a-z_][a-z0-9_-]{0,31} rule and must not be a
// name the OS or the box already depends on.

describe("checkUsername", () => {
  it.each(["alice", "bob2", "a", "dev_ops", "x-ray", "a".repeat(32), "k9"])("accepts %s", (name) => {
    expect(checkUsername(name)).toBe("ok");
  });

  it.each([
    ["", "empty"],
    ["Alice", "upper case"],
    ["9lives", "leading digit"],
    ["-rf", "leading dash (an option to useradd)"],
    ["a".repeat(33), "33 characters"],
    ["al ice", "space"],
    ["al:ice", "colon (the chpasswd field separator)"],
    ["alice\n", "newline"],
    ["alice\nroot", "embedded newline"],
    ["alice$", "machine-account suffix"],
    ["../etc", "path"],
    ["alice;rm -rf /", "shell metacharacters"],
    ["$(id)", "command substitution"],
    ["ålice", "non-ASCII"],
  ])("refuses %j (%s) as invalid", (name) => {
    expect(checkUsername(name)).toBe("invalid");
  });

  it("refuses anything that is not a string", () => {
    for (const value of [undefined, null, 42, {}, ["alice"]]) {
      expect(checkUsername(value)).toBe("invalid");
    }
  });

  it.each(["root", "daemon", "www-data", "nobody", "sudo", "admin", "clawbox", "ollama", "sshd", "me", "owner"])(
    "refuses the reserved name %s",
    (name) => {
      expect(checkUsername(name)).toBe("reserved");
    },
  );

  it.each(["systemd-network", "_apt", "clawbox-users", "clawboxer"])("refuses the reserved family member %s", (name) => {
    expect(checkUsername(name)).toBe("reserved");
  });

  it("only reserves names the rule could otherwise accept", () => {
    for (const name of RESERVED_USERNAMES) {
      expect(USERNAME_RE.test(name), name).toBe(true);
    }
  });
});

describe("assertCreatable", () => {
  const owner = "clawbox";
  const existing = [{ username: "alice", createdAt: "", sv: "0123456789abcdef" }];

  function refusal(fn: () => void): string | null {
    try {
      fn();
      return null;
    } catch (err) {
      return err instanceof UserAdminError ? err.code : "threw-something-else";
    }
  }

  it("accepts a fresh name and a good password", () => {
    expect(refusal(() => assertCreatable("bob", "correct horse", owner, existing))).toBeNull();
  });

  it("maps each rule to its own code", () => {
    expect(refusal(() => assertCreatable("Bob", "correct horse", owner, existing))).toBe("invalid_username");
    expect(refusal(() => assertCreatable("root", "correct horse", owner, existing))).toBe("reserved_username");
    expect(refusal(() => assertCreatable("alice", "correct horse", owner, existing))).toBe("user_exists");
    expect(refusal(() => assertCreatable("bob", "short", owner, existing))).toBe("invalid_password");
    expect(refusal(() => assertCreatable("bob", "has\nnewline", owner, existing))).toBe("invalid_password");
    expect(refusal(() => assertCreatable("bob", "x".repeat(257), owner, existing))).toBe("invalid_password");
    expect(refusal(() => assertCreatable("bob", undefined, owner, existing))).toBe("invalid_password");
  });

  it("refuses the owner's own name even when the owner is not a reserved word", () => {
    expect(refusal(() => assertCreatable("nexus", "correct horse", "nexus", []))).toBe("user_exists");
  });
});

describe("userAddRecord", () => {
  it("is exactly one user:password record", () => {
    expect(userAddRecord("bob", "p:a:ss word")).toBe("bob:p:a:ss word\n");
  });

  it("refuses a name or password that could forge a second record", () => {
    expect(() => userAddRecord("bob\nroot", "x".repeat(8))).toThrow();
    expect(() => userAddRecord("root", "x".repeat(8))).toThrow();
    expect(() => userAddRecord("bob", "pass\nroot:pwned")).toThrow();
    expect(() => userAddRecord("bob", "pass\rword")).toThrow();
    expect(() => userAddRecord("bob", "pass\0word")).toThrow();
  });
});
