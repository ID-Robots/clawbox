/**
 * Which grammar colours a file (src/lib/code-language.ts): by extension,
 * by a few well-known names, and plain for anything else.
 */
import { describe, expect, it } from "vitest";
import { CODE_LANGUAGES, languageForFile } from "@/lib/code-language";

describe("languageForFile", () => {
  it("names a grammar for the files a run writes", () => {
    expect(languageForFile("index.html")).toBe("markup");
    expect(languageForFile("icon.svg")).toBe("markup");
    expect(languageForFile("style.css")).toBe("css");
    expect(languageForFile("app.js")).toBe("javascript");
    expect(languageForFile("src/App.tsx")).toBe("tsx");
    expect(languageForFile("lib/util.ts")).toBe("typescript");
    expect(languageForFile("package.json")).toBe("json");
    expect(languageForFile("main.py")).toBe("python");
    expect(languageForFile("run.sh")).toBe("bash");
    expect(languageForFile("README.md")).toBe("markdown");
    expect(languageForFile("config.yml")).toBe("yaml");
    expect(languageForFile("schema.sql")).toBe("sql");
    expect(languageForFile("main.go")).toBe("go");
    expect(languageForFile("lib.rs")).toBe("rust");
    expect(languageForFile("a.c")).toBe("c");
    expect(languageForFile("a.hpp")).toBe("cpp");
    expect(languageForFile("Main.java")).toBe("java");
    expect(languageForFile("app.rb")).toBe("ruby");
    expect(languageForFile("Cargo.toml")).toBe("toml");
    expect(languageForFile("setup.cfg")).toBe("ini");
  });

  it("knows a few files by name, case aside", () => {
    expect(languageForFile("Dockerfile")).toBe("docker");
    expect(languageForFile("dockerfile.dev")).toBe("docker");
    expect(languageForFile("Makefile")).toBe("bash");
    expect(languageForFile(".bashrc")).toBe("bash");
    expect(languageForFile(".editorconfig")).toBe("ini");
    expect(languageForFile("INDEX.HTML")).toBe("markup");
  });

  it("answers plain for what it does not know, never a refusal", () => {
    expect(languageForFile("notes.txt")).toBeNull();
    expect(languageForFile("LICENSE")).toBeNull();
    expect(languageForFile(".gitignore")).toBeNull();
    expect(languageForFile("photo.png")).toBeNull();
    expect(languageForFile("")).toBeNull();
  });

  it("only ever names a grammar the highlighter loads", () => {
    const named = new Set<string>();
    for (const name of ["a.html", "a.css", "a.scss", "a.js", "a.jsx", "a.ts", "a.tsx", "a.json", "a.py", "a.sh", "a.yml", "a.md", "a.sql", "a.go", "a.rs", "a.c", "a.cpp", "a.java", "a.rb", "a.toml", "Dockerfile", "a.ini"]) {
      const lang = languageForFile(name);
      if (lang) named.add(lang);
    }
    for (const lang of named) expect(CODE_LANGUAGES).toContain(lang);
    expect(named.size).toBe(CODE_LANGUAGES.length);
  });
});
