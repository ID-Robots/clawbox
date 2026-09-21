import { describe, expect, it } from "vitest";
import { githubRepoName, githubWebUrl } from "@/lib/github-url";

describe("githubWebUrl", () => {
  it("turns the https and ssh forms of a GitHub remote into the repository's page", () => {
    expect(githubWebUrl("https://github.com/yalexx/invoice-generator.git")).toBe("https://github.com/yalexx/invoice-generator");
    expect(githubWebUrl("https://github.com/yalexx/invoice-generator")).toBe("https://github.com/yalexx/invoice-generator");
    expect(githubWebUrl("git@github.com:yalexx/invoice-generator.git")).toBe("https://github.com/yalexx/invoice-generator");
    expect(githubWebUrl("ssh://git@github.com/yalexx/invoice-generator.git")).toBe("https://github.com/yalexx/invoice-generator");
    expect(githubWebUrl("https://token@github.com/yalexx/x.git")).toBe("https://github.com/yalexx/x");
    expect(githubRepoName("https://github.com/yalexx/invoice-generator.git")).toBe("yalexx/invoice-generator");
  });

  it("answers null for no remote, a remote that is not GitHub, and a shape that is not a repository", () => {
    expect(githubWebUrl(null)).toBeNull();
    expect(githubWebUrl("")).toBeNull();
    expect(githubWebUrl("https://gitlab.com/yalexx/x.git")).toBeNull();
    expect(githubWebUrl("https://github.com/yalexx")).toBeNull();
    expect(githubWebUrl("https://github.com/../x.git")).toBeNull();
    expect(githubWebUrl("https://evil.example/github.com/a/b")).toBeNull();
  });
});
