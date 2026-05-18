/**
 * Catalog queries -- thin TanStack Query wrappers around the read-only
 * resource catalogs (agents, costs, schedules, runtimes, models, skills).
 *
 * Each hook is a single `useQuery` call with a fixed query key and no
 * caching strategy, schema validation, or transformation. They live in
 * one file rather than five single-function files because there's no
 * abstraction to spread out; one hook per resource is just a name.
 */

import { useQuery } from "@tanstack/react-query";
import { useApi } from "./useApi.js";

export function useAgentsQuery() {
  const api = useApi();
  return useQuery({ queryKey: ["agents"], queryFn: api.getAgents });
}

export function useCostsQuery() {
  const api = useApi();
  return useQuery({ queryKey: ["costs"], queryFn: api.getCosts });
}

export function useSchedulesQuery() {
  const api = useApi();
  return useQuery({ queryKey: ["schedules"], queryFn: api.getSchedules });
}

export function useRuntimesQuery() {
  const api = useApi();
  return useQuery({ queryKey: ["runtimes"], queryFn: api.getRuntimes });
}

/**
 * Canonical model catalog (file-backed three-tier store, surfaced over
 * `model/list`). Each entry carries `id`, `display`, `provider`, optional
 * aliases, and per-provider slugs. The catalog is the single source of
 * truth for the model selector on agent forms; runtime YAMLs no longer
 * advertise their own model list.
 */
export function useModelsQuery() {
  const api = useApi();
  return useQuery({ queryKey: ["models"], queryFn: api.getModels });
}

export function useSkillsQuery() {
  const api = useApi();
  return useQuery({ queryKey: ["skills"], queryFn: api.getSkills });
}
