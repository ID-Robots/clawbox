/**
 * Presentational primitives for the Settings window.
 *
 * Everything in this folder is STYLE ONLY: no fetching, no polling, no gating,
 * no business logic. SettingsApp keeps every effect, ref and handler it has —
 * these components take props and paint.
 *
 * They read colour exclusively from the `--set-*` roles declared on
 * `.settings-pane` in `src/app/globals.css`, which is what lets the same markup
 * render in the ClawBox palette and in Hermes.
 */

export { default as SettingsGroup } from "./SettingsGroup";
export type { SettingsGroupProps } from "./SettingsGroup";

export { default as SettingsGroupHeader } from "./SettingsGroupHeader";
export type { SettingsGroupHeaderProps } from "./SettingsGroupHeader";

export { default as SettingsRow } from "./SettingsRow";
export type { SettingsRowProps } from "./SettingsRow";

export { default as SettingsNav } from "./SettingsNav";
export type { SettingsNavProps, SettingsNavItem } from "./SettingsNav";

export { default as SettingsSwitch } from "./SettingsSwitch";
export type { SettingsSwitchProps } from "./SettingsSwitch";

export { default as SettingsSlider } from "./SettingsSlider";
export type { SettingsSliderProps } from "./SettingsSlider";

export { default as SettingsSegmented } from "./SettingsSegmented";
export type {
  SettingsSegmentedProps,
  SettingsSegmentedOption,
} from "./SettingsSegmented";

export { default as SettingsTextField } from "./SettingsTextField";
export type { SettingsTextFieldProps } from "./SettingsTextField";

export { SHAPE, SPACE, TYPE, TOUCH_TARGET } from "./tokens";
