import { describe, expect, it } from "vitest";
import {
  allocateClaimId,
  assertClaimIdAvailable,
  buildClaimIndex,
  claimCollisions,
  ClaimIdError,
  isClaimId,
  makeClaimId,
  parseClaimId,
  retireClaimsOnPage,
  retiredReuse,
  slugify,
} from "@/lib/prime-radiant/claims";
import { claim, frontmatter } from "../helpers/prime-radiant-fixtures";

const page = (path: string, ids: string[], retired: string[] = []) => ({
  path,
  frontmatter: frontmatter({ claims: ids.map((id) => claim(id)), retiredClaimIds: retired }),
});

describe("claim id namespace", () => {
  it("accepts only <domain>/<entity>/<fact> in lowercase kebab", () => {
    expect(isClaimId("acme-sales/acme-widgets/price-2026")).toBe(true);
    for (const bad of ["acme/widgets", "Acme/widgets/price", "a/b/c/d", "a//c", "a/b/c-", "a/b/c d", "", "a/b/" + "x".repeat(300)]) {
      expect(isClaimId(bad)).toBe(false);
    }
    expect(parseClaimId("acme-sales/acme-widgets/price")).toEqual({ domain: "acme-sales", entity: "acme-widgets", fact: "price" });
  });

  it("slugifies text into the id alphabet", () => {
    expect(slugify("Acme Widgets Ltd.")).toBe("acme-widgets-ltd");
    expect(slugify("Café Déjà Vu")).toBe("cafe-deja-vu");
    expect(slugify("!!!")).toBe("x");
    expect(slugify("a".repeat(100)).length).toBeLessThanOrEqual(64);
    expect(makeClaimId("Acme Sales", "Acme Widgets", "Blue price")).toBe("acme-sales/acme-widgets/blue-price");
  });

  it("transliterates Bulgarian titles by the official system instead of dropping them", () => {
    expect(slugify("Граждански договор — Иван Иванов")).toBe("grazhdanski-dogovor-ivan-ivanov");
    expect(slugify("Щастие, юни, ябълка")).toBe("shtastie-yuni-yabalka");
    expect(slugify("Жълт цвят, чаша, шише, йога, Мальовица")).toBe("zhalt-tsvyat-chasha-shishe-yoga-malyovitsa");
    // `-ия` closing a word is `ia`; inside one it is `iya`.
    expect(slugify("Компания София")).toBe("kompania-sofia");
    expect(slugify("Ияков")).toBe("iyakov");
    // Upper case, a decomposed й and ѝ (и with a grave accent) read as the letters they are.
    expect(slugify("ДОГОВОР ЗА НАЕМ")).toBe("dogovor-za-naem");
    expect(slugify("Край на ЮЛИ")).toBe("kray-na-yuli");
    expect(slugify("Кра\u0438\u0306 и \u045d")).toBe("kray-i-i");
  });

  it("transliterates Russian, Ukrainian and Serbian letters Bulgarian lacks, and mixed scripts", () => {
    expect(slugify("Ёлка, мыло, эхо")).toBe("yolka-mylo-eho");
    expect(slugify("Київ, Євген, ґанок")).toBe("kiyiv-yevgen-ganok");
    expect(slugify("Ђорђе Љубић Њеш Џеп")).toBe("djordje-ljubic-njesh-dzep");
    expect(slugify("Договор с Acme Ltd № 12 (2026)")).toBe("dogovor-s-acme-ltd-no-12-2026");
    expect(slugify("Globex — Фактура 0042")).toBe("globex-faktura-0042");
    // Other scripts are still dropped; nothing at all is still `x`.
    expect(slugify("東京")).toBe("x");
    expect(slugify("Отчёт 東京")).toBe("otchyot");
  });

  it("keeps the length cap after transliteration and never ends on a dash", () => {
    const long = slugify("Щъркел ".repeat(30), 80);
    expect(long.length).toBeLessThanOrEqual(80);
    expect(long.startsWith("shtarkel-shtarkel")).toBe(true);
    expect(long.endsWith("-")).toBe(false);
    expect(slugify("Щъ щъ", 5)).toBe("shta");
    expect(slugify("Щ", 2)).toBe("sh");
  });

  it("is deterministic", () => {
    const title = "Протокол № 3 от общото събрание — Globex ЕООД";
    expect(slugify(title)).toBe(slugify(title));
    expect(slugify(title)).toBe("protokol-no-3-ot-obshtoto-sabranie-globex-eood");
  });

  it("finds collisions across pages and inside one", () => {
    const index = buildClaimIndex([page("a.md", ["d/e/f", "d/e/g"]), page("b.md", ["d/e/f"]), page("c.md", ["d/x/y", "d/x/y"])]);
    expect(claimCollisions(index).map((c) => c.id)).toEqual(["d/e/f", "d/x/y"]);
  });

  it("never lets a retired id come back, from a page or from the ledger", () => {
    const index = buildClaimIndex([page("a.md", ["d/e/new"], ["d/e/old"]), page("b.md", ["d/e/old", "d/e/gone"])], ["d/e/gone"]);
    expect(retiredReuse(index).map((r) => [r.id, r.retiredBy])).toEqual([
      ["d/e/gone", ["ledger"]],
      ["d/e/old", ["a.md"]],
    ]);
    expect(() => assertClaimIdAvailable(index, "d/e/old", "c.md")).toThrow(ClaimIdError);
    try {
      assertClaimIdAvailable(index, "d/e/gone", "c.md");
    } catch (err) {
      expect((err as ClaimIdError).code).toBe("retired");
    }
  });

  it("allows an update of the same id on its own page, refuses it on another", () => {
    const index = buildClaimIndex([page("a.md", ["d/e/f"])]);
    expect(() => assertClaimIdAvailable(index, "d/e/f", "a.md")).not.toThrow();
    expect(() => assertClaimIdAvailable(index, "d/e/f", "b.md")).toThrow(/already used on a.md/);
    expect(() => assertClaimIdAvailable(index, "nope", "a.md")).toThrow(/not a claim id/);
  });

  it("allocates the next free id past taken and retired ones", () => {
    const index = buildClaimIndex([page("a.md", ["acme/widget/price"], ["acme/widget/price-2"])]);
    expect(allocateClaimId(index, "acme", "Widget", "Price", "b.md")).toBe("acme/widget/price-3");
    expect(allocateClaimId(index, "acme", "Widget", "Price", "a.md")).toBe("acme/widget/price");
    expect(allocateClaimId(index, "acme", "Widget", "Colour", "b.md")).toBe("acme/widget/colour");
  });

  it("retires only the ids a page carried, keeping the replacement", () => {
    const fm = frontmatter({ claims: [claim("d/e/a"), claim("d/e/b"), claim("d/e/keep")], retiredClaimIds: ["d/e/old"] });
    const { frontmatter: out, removed } = retireClaimsOnPage(fm, ["d/e/a", "d/e/keep", "d/e/elsewhere"], "d/e/keep");
    expect(removed).toEqual(["d/e/a"]);
    expect(out.claims.map((c) => c.id)).toEqual(["d/e/b", "d/e/keep"]);
    expect(out.retiredClaimIds).toEqual(["d/e/a", "d/e/old"]);
    expect(fm.claims).toHaveLength(3); // pure
  });
});
