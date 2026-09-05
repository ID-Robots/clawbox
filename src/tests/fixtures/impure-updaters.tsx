/**
 * Fixture for `src/tests/unit/state-updater-purity.test.ts`. NOT shipped code
 * and not a test file: it is the set of shapes the rule has to catch, kept out
 * of the walked directories so the rule can assert an empty list over the real
 * tree and still be known to be looking.
 *
 * Every one of these went undetected by the regex version of the guard.
 */

type Setter<T> = (next: T | ((prev: T) => T)) => void;

/**
 * The literal that used to turn the whole scan off.
 *
 * The hand-rolled blanker had no notion of a regex literal, so this quote
 * opened a string span that ran to the next quote in the file, inverting its
 * idea of what was code from here on — and it reported nothing, green.
 */
const QUOTES = /['"]/g;

export function shapes(
  setStreaming: Setter<string>,
  setMessages: Setter<string[]>,
  setFromFunctionExpression: Setter<string>,
  applyWrapper: Setter<string>,
  applyStreaming: (next: string) => void,
  setWithRefWrite: Setter<string>,
  setConciseRefWrite: Setter<string>,
  setCompoundRefWrite: Setter<string>,
  setThroughProperty: Setter<string>,
  catalog: { setSort: (next: string) => void },
  streamingRef: { current: string },
): void {
  // The defect as it shipped: a sibling setter called from inside an updater.
  setStreaming((prev) => {
    setMessages((msgs) => [...msgs, prev]);
    return "";
  });

  // The same thing written as a function expression — what a refactor reaches
  // for when the body grows, and what an arrow-only opener walked straight past.
  setFromFunctionExpression(function (prev: string) {
    setMessages((msgs) => [...msgs, prev]);
    return "";
  });

  // An `apply*` wrapper may neither be called from inside an updater nor take
  // one: it writes the ref, so React running it twice desynchronises the ref
  // from the state at commit time.
  applyWrapper((prev) => {
    applyStreaming("");
    return prev;
  });

  // A render-phase ref mutation. Strictly worse than the original defect, and
  // the rule the fix itself leans on.
  setWithRefWrite((prev) => {
    streamingRef.current = prev;
    return prev;
  });

  // A concise arrow body that IS the write. It type-checks (an assignment
  // evaluates to the assigned value) and it lints clean, and it went unseen
  // while the same code in braces was caught — the rule's answer must not
  // depend on a pair of brackets.
  // Deliberately UNPARENTHESISED: with brackets the body node is a
  // ParenthesizedExpression whose child is the assignment, so a walk that
  // visited only the children caught it; without them the body IS the
  // assignment and that walk saw nothing. Adding the brackets here would make
  // this case pass against the defect it exists to pin.
  setConciseRefWrite((prev) => streamingRef.current = prev);

  // The compound form. `someRef.current += 1` is the generation-counter idiom
  // this codebase uses in thirteen places, and accumulating a streaming buffer
  // with `+=` inside an updater is the most natural wrong way to write the
  // defect this rule exists for.
  setCompoundRefWrite((prev) => {
    streamingRef.current += prev;
    return "";
  });

  // A setter reached through a PROPERTY, in the nested position. This is live
  // style in this repo, not a hypothetical: `HermesSkillsStore.tsx` calls
  // `catalog.setSort(...)` / `catalog.setQuery(...)` — state writers returned
  // on a hook's object — and a bare-identifier rule reports nothing for them.
  // The nested position is where the defect lives, so it is the position that
  // may not be blind.
  setThroughProperty((prev) => {
    catalog.setSort("name");
    return prev;
  });

  // NOT offenders, and here so the rule is known to leave them alone: a timer
  // callback is not an updater (React never re-runs it), and neither of these
  // sits inside an updater to begin with — the property rule above applies in
  // the nested position only, so a `localStorage.setItem` at the top level of a
  // component is not a finding.
  setTimeout(() => setMessages((msgs) => msgs), 0);
  localStorage.setItem("clawbox:fixture", QUOTES.source);
}
