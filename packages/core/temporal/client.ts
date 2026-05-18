import { Connection, Client } from "@temporalio/client";
import type { TemporalConfig } from "../config/types.js";

/**
 * Temporal clients cached per (serverUrl, namespace) pair. A multi-tenant
 * control plane may hand different tenant contexts different namespaces;
 * a single module-level singleton would silently return the first-built
 * client to every caller regardless of the namespace they asked for.
 */
const clients = new Map<string, Client>();

export function temporalClientKey(cfg: Pick<TemporalConfig, "serverUrl" | "namespace">): string {
  return `${cfg.serverUrl}|${cfg.namespace}`;
}

export async function getTemporalClient(cfg: TemporalConfig): Promise<Client> {
  const key = temporalClientKey(cfg);
  const existing = clients.get(key);
  if (existing) return existing;
  const connection = await Connection.connect({ address: cfg.serverUrl });
  const client = new Client({ connection, namespace: cfg.namespace });
  clients.set(key, client);
  return client;
}

export async function closeTemporalClient(cfg?: TemporalConfig): Promise<void> {
  // Close one specific client when cfg is supplied; otherwise close all.
  // The all-close form is what process-shutdown paths want.
  if (cfg) {
    const key = temporalClientKey(cfg);
    const client = clients.get(key);
    if (client) {
      await client.connection.close();
      clients.delete(key);
    }
    return;
  }
  for (const [key, client] of clients) {
    await client.connection.close();
    clients.delete(key);
  }
}
