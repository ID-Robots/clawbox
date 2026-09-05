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

  // NOT offenders, and here so the rule is known to leave them alone: a timer
  // callback is not an updater (React never re-runs it), and a method call is
  // not a state writer.
  setTimeout(() => setMessages((msgs) => msgs), 0);
  localStorage.setItem("clawbox:fixture", QUOTES.source);
}
