/**
 * Which projects run EVERY run through the delivery pipeline.
 *
 * The owner asked for the whole flow to be automatic "from start to finish",
 * and asking for it per run is only half of that: a project the owner ships
 * from every day should not need the switch typed into each prompt. So a
 * project can carry the pipeline as its DEFAULT, and a run in it gets one
 * without anyone naming it.
 *
 * It is a standing consent — a run started by the assistant in that project
 * will, unattended, deploy a preview and (where the production switch is also
 * on) the project's own domain — so it is written by the owner's own session
 * only, from this box's pages, and it fails towards OFF on every unreadable
 * value. See ./project-switch, which is the whole of that behaviour, shared
 * with the production switch it sits beside.
 */
import { readProjectSwitch, readProjectSwitches, setProjectSwitch } from "@/lib/project-switch";

/** Where the per-project pipeline default lives in `data/config.json`. */
export const PIPELINE_PROJECTS_CONFIG_KEY = "coding_pipeline_projects";

export function readPipelineDefault(scope: string | null | undefined): Promise<boolean> {
  return readProjectSwitch(PIPELINE_PROJECTS_CONFIG_KEY, scope);
}

export function readPipelineProjects(): Promise<string[]> {
  return readProjectSwitches(PIPELINE_PROJECTS_CONFIG_KEY);
}

export function setPipelineDefault(scope: string, enabled: boolean): Promise<boolean> {
  return setProjectSwitch(PIPELINE_PROJECTS_CONFIG_KEY, scope, enabled);
}
