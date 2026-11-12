import { createContext } from "react";

/**
 * May a cloud provider be marked RECOMMENDED here? False under a box whose AI
 * is the owner's own (an external engine, Local-only mode — TASK-2497): the
 * local choice is the recommended one there, and the cloud providers are the
 * optional extra. True everywhere else, which is every screen as it was.
 */
export const CloudRecommendContext = createContext(true);
