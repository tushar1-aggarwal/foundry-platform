import type { ProjectionInput } from "../types.js";

// Stage status writes are no-ops until session_stages table is introduced.
export async function projectStageActivity(_input: ProjectionInput): Promise<void> {}
