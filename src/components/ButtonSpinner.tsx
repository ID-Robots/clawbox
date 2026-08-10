// Shared inline spinner for button labels. Extracted verbatim from
// AIModelsStep so the Hermes panel's ClawBox AI buttons animate identically —
// an element, not a component, because every existing call site passes it as a
// ReactNode prop (`buttonSpinner={ButtonSpinner}`).
export const ButtonSpinner = (
  <span className="inline-block w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
);

export default ButtonSpinner;
