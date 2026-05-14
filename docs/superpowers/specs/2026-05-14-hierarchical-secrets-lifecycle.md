# Hierarchical Secrets -- Lifecycle Diagram

Live mermaid view of the secrets manager component covering **creation**, **retrieval**, and **usage** within an Ark session environment. Backed by:

- `docs/superpowers/specs/2026-05-13-hierarchical-secrets-design.md`
- `docs/superpowers/specs/2026-05-13-hierarchical-secrets-flow.md`

---

## End-to-end lifecycle (flowchart)

```mermaid
flowchart TB
    %% =========================================================
    %% PHASE 1 -- CREATION (boot + onboard + write)
    %% =========================================================
    subgraph CREATION["PHASE 1 -- CREATION"]
        direction TB

        subgraph BOOT["arkd boot"]
            ENV[("ARK_MASTER_KEY<br/>(env var, 32B base64)")]
            LOADKEK["loadMasterKey()<br/>kek/load.ts"]
            KEKBUF["SecureBuffer<br/>master KEK in RAM"]
            ENV --> LOADKEK --> KEKBUF
        end

        subgraph ONBOARD_T["ark onboard tenant"]
            T1["Create tenants row"]
            T2["tenant-dek.ts:<br/>crypto.randomBytes(32)"]
            T3["AES-256-GCM wrap<br/>AAD = 'dek' || tenant_id"]
            T4[("tenant_deks<br/>(wrapped_dek, nonce, tag,<br/>kek_version, dek_version)")]
            T5["Walk registry where<br/>required_at_scope='tenant'"]
            T6["Prompt admin / read<br/>ARK_ONBOARD_KEY env"]
            T1 --> T2 --> T3 --> T4
            T4 --> T5 --> T6
        end

        subgraph ONBOARD_TM["ark onboard team / user"]
            U1["Walk registry where<br/>required_at_scope='team'|'user'"]
            U2["Prompt (TTY or non-interactive)"]
            U1 --> U2
        end

        subgraph WRITE["PUT /secrets/bindings"]
            W1["SecretsCallerContext<br/>(user_session / api_key / system)"]
            W2{"canWrite(caller,<br/>scope_kind, scope_id, key)"}
            W3{"registry.policy<br/>== 'locked'?"}
            W4["Reject 403<br/>(no orphan blob)"]
            W5["Unwrap tenant DEK<br/>using master KEK"]
            W6[("DEK cache<br/>(per tenant, RAM)")]
            W7["AES-256-GCM encrypt<br/>AAD = tenant_id || scope_kind ||<br/>scope_id || key || secret_type"]
            W8[("secret_blobs<br/>(ref, ciphertext, nonce, tag,<br/>aad_fingerprint, dek_version)")]
            W9[("secret_bindings<br/>(tenant_id, scope_kind, scope_id,<br/>key, secret_ref, secret_type,<br/>metadata_json, admin_override)")]
            W10[("secret_audit_log<br/>action=put_binding,<br/>outcome=ok|denied")]
            W11["Response:<br/>{ok, ref, scope, key, updated_at}<br/>NEVER plaintext"]

            W1 --> W2
            W2 -- "deny" --> W4
            W2 -- "allow" --> W3
            W3 -- "locked & scope!=tenant" --> W4
            W3 -- "ok" --> W5
            W5 --> W7
            W6 -. cache hit .-> W7
            W7 --> W8
            W8 --> W9
            W9 --> W10
            W9 --> W11
        end

        T6 --> W1
        U2 --> W1
        KEKBUF -. unwrap on demand .-> W5
        W5 -. populate .-> W6
    end

    %% =========================================================
    %% PHASE 2 -- RETRIEVAL (dispatch resolver)
    %% =========================================================
    subgraph RETRIEVAL["PHASE 2 -- RETRIEVAL"]
        direction TB

        D1["Session dispatch starts<br/>session-orchestration.ts"]
        D2["effectiveSecretsForSession(app, session)<br/>ctx = kind:'system',<br/>reason:'dispatch.session'"]
        D3["sessionScope = {<br/>tenantId, userId,<br/>teamChain (from sessions_auth)<br/>}"]
        D4["listKeysForScope(ctx, sessionScope)"]

        subgraph RESOLVE["resolver.ts -- per key"]
            direction TB
            R1{"registry.policy<br/>== 'locked'?"}
            R2["Lookup only<br/>scope=tenant binding"]
            R3["Walk order:<br/>user -> teamChain[0..n] -> tenant<br/>(most-specific first)"]
            R4["lookupBinding<br/>(tenant_id, scope_kind, scope_id, key)"]
            R5{"Binding<br/>found?"}
            R6["Verify aad_fingerprint<br/>against expected AAD"]
            R7["Unwrap tenant DEK<br/>(cache or master KEK)"]
            R8["AES-256-GCM decrypt<br/>(SecureBuffer plaintext)"]
            R9["Return TypedSecret<br/>{type, metadata, bytes}"]
            R10["Return null<br/>(emit warning audit row)"]

            R1 -- "yes" --> R2 --> R5
            R1 -- "no" --> R3 --> R4 --> R5
            R5 -- "yes" --> R6 --> R7 --> R8 --> R9
            R5 -- "no & more scopes" --> R3
            R5 -- "exhausted" --> R10
        end

        D5["Stage / runtime YAML<br/>secrets: [NAME] narrowing"]
        D6["Effective TypedSecret[]<br/>for this session"]
        D7[("secret_audit_log<br/>action=resolve,<br/>actor_kind=system,<br/>on_behalf_of_user_id=...,<br/>caller_reason=dispatch.session")]

        D1 --> D2 --> D3 --> D4
        D4 --> RESOLVE
        RESOLVE --> D5 --> D6
        RESOLVE --> D7
    end

    %% =========================================================
    %% PHASE 3 -- USAGE (placement into the agent environment)
    %% =========================================================
    subgraph USAGE["PHASE 3 -- USAGE IN ENVIRONMENT"]
        direction TB

        P1{"Capability matrix:<br/>(compute, isolation) supports<br/>file-based secrets?"}
        P2["Reject dispatch<br/>pre-decryption<br/>(LocalCompute + direct +<br/>ssh-key/kubeconfig/blob)"]
        P3["placeAllSecrets(effective set)<br/>typed-secrets pipeline"]

        subgraph PLACERS["per-type placers"]
            direction TB
            PL1["env-var placer<br/>-> agent process env"]
            PL2["ssh-private-key placer<br/>-> tmpfs file + chmod 0600"]
            PL3["kubeconfig placer<br/>-> tmpfs KUBECONFIG path"]
            PL4["generic-blob placer<br/>-> tmpfs file"]
        end

        subgraph RAMFS["per-session RAM-backed FS"]
            direction TB
            FS1["Linux host:<br/>tmpfs /run/ark/session/&lt;id&gt;/<br/>noexec, nosuid, 0700"]
            FS2["Docker: --tmpfs /run/ark<br/>noexec,nosuid,size=64m"]
            FS3["K8s: emptyDir<br/>medium: Memory"]
            FS4["MicroVM (Firecracker/Kata):<br/>RAM-backed rootfs path"]
            FS5["EC2 / remote:<br/>cloud-init tmpfs mount"]
        end

        AGENT[["Agent process<br/>(claude / codex / gemini / goose<br/>inside tmux ark-s-&lt;id&gt;)"]]

        TD1["Session teardown"]
        TD2["Unmount tmpfs /<br/>destroy container or VM"]
        TD3["Kernel reclaims RAM"]
        TD4["SecureBuffer.dispose()<br/>zero plaintext + DEK if evicted"]

        P1 -- "no" --> P2
        P1 -- "yes" --> P3
        P3 --> PL1
        P3 --> PL2
        P3 --> PL3
        P3 --> PL4
        PL2 --> RAMFS
        PL3 --> RAMFS
        PL4 --> RAMFS
        PL1 --> AGENT
        RAMFS --> AGENT
        AGENT --> TD1 --> TD2 --> TD3 --> TD4
    end

    %% =========================================================
    %% INTER-PHASE EDGES
    %% =========================================================
    W9 -. "rows available<br/>to resolver" .-> R4
    KEKBUF -. shared cache .-> R7
    W6 -. shared cache .-> R7
    D6 --> P1

    %% =========================================================
    %% STYLES
    %% =========================================================
    classDef store fill:#1f2937,stroke:#6366f1,stroke-width:1px,color:#e5e7eb;
    classDef danger fill:#7f1d1d,stroke:#f87171,color:#fee2e2;
    classDef secure fill:#064e3b,stroke:#34d399,color:#d1fae5;
    classDef decision fill:#78350f,stroke:#fbbf24,color:#fef3c7;

    class ENV,T4,W6,W8,W9,W10,D7 store;
    class W4,P2,R10 danger;
    class KEKBUF,R8,R9,TD4 secure;
    class W2,W3,R1,R5,P1 decision;
```

---

## Dispatch-time sequence (zoomed in)

```mermaid
sequenceDiagram
    autonumber
    participant Op as Operator
    participant Env as ARK_MASTER_KEY
    participant Arkd as arkd
    participant DB as SQLite/Postgres
    participant DEK as tenant DEK cache
    participant Disp as Dispatcher
    participant Plc as Placer
    participant TMP as tmpfs /run/ark/session/&lt;id&gt;/
    participant Agt as Agent process

    Op->>Env: export ARK_MASTER_KEY=$(openssl rand -base64 32)
    Op->>Arkd: start arkd
    Arkd->>Env: read once at startup
    Arkd->>Arkd: SecureBuffer(master KEK)

    Note over Disp,DB: session.start (user U, tenant T, teamChain [Ta, Tb])

    Disp->>Arkd: effectiveSecretsForSession(session)
    Arkd->>DB: SELECT team_chain FROM sessions_auth
    Arkd->>DB: SELECT keys FROM secret_keys_registry WHERE tenant_id=T

    loop per registered key K
        Arkd->>DB: SELECT policy FROM secret_keys_registry
        alt policy = locked
            Arkd->>DB: lookupBinding(T, 'tenant', T, K)
        else policy = overridable
            Arkd->>DB: lookupBinding(T, 'user', U, K)
            opt no user binding
                Arkd->>DB: lookupBinding(T, 'team', Ta, K)
            end
            opt no team binding
                Arkd->>DB: lookupBinding(T, 'team', Tb, K)
            end
            opt no team binding
                Arkd->>DB: lookupBinding(T, 'tenant', T, K)
            end
        end
        DB-->>Arkd: secret_bindings + secret_blobs row
        Arkd->>Arkd: verify aad_fingerprint
        alt DEK cached
            DEK-->>Arkd: tenant DEK (SecureBuffer)
        else cache miss
            Arkd->>DB: SELECT wrapped_dek FROM tenant_deks
            Arkd->>Arkd: AES-GCM unwrap with master KEK<br/>AAD = 'dek' || tenant_id
            Arkd->>DEK: cache tenant DEK
        end
        Arkd->>Arkd: AES-GCM decrypt blob<br/>AAD = T||scope_kind||scope_id||K||secret_type
        Arkd->>DB: INSERT secret_audit_log<br/>action=resolve, outcome=ok
    end

    Arkd-->>Disp: TypedSecret[] (effective set)

    Disp->>Disp: capability matrix check<br/>(compute, isolation)

    alt LocalCompute + direct AND file-based secret present
        Disp-->>Disp: reject dispatch, emit named error
    else combo supports RAM-backed FS
        Disp->>Plc: placeAllSecrets(effective set, ctx)
        loop per TypedSecret
            alt secret_type = env-var
                Plc->>Agt: inject into process env
            else file-based (ssh-private-key / kubeconfig / generic-blob)
                Plc->>TMP: write file (0600, owner=agent UID)
                Plc->>Agt: pass path (e.g. SSH_PRIVATE_KEY_FILE, KUBECONFIG)
            end
        end
        Plc->>Plc: SecureBuffer.dispose() plaintext after placement
    end

    Agt->>Agt: agent runs (claude/codex/gemini/goose)

    Note over Agt,TMP: session ends

    Disp->>TMP: unmount tmpfs / destroy container / destroy VM
    TMP-->>Arkd: RAM reclaimed by kernel
    Note over DEK: DEK stays cached for daemon lifetime;<br/>invalidated only on rotation
```

---

## Legend

| Region | Maps to |
|---|---|
| `ARK_MASTER_KEY` env | `EnvKekBackend`, `packages/secrets/kek/load.ts` |
| `tenant_deks` / DEK cache | `packages/secrets/tenant-dek.ts` |
| Wrap / unwrap / cipher | `packages/secrets/cipher.ts` (AES-256-GCM + AAD) |
| `canWrite()` | `packages/secrets/service.ts` |
| Walk `user -> teamChain -> tenant` | `packages/secrets/resolver.ts` |
| `placeAllSecrets` | Typed-secrets pipeline (unchanged) |
| Capability matrix | `packages/secrets/placement-isolation.ts` |
| Audit rows | `packages/secrets/audit.ts` -> `secret_audit_log` |

Three invariants the diagram makes load-bearing:

1. **Master KEK never persists** -- only lives in `ARK_MASTER_KEY` and `SecureBuffer`. DB dump alone yields no plaintext.
2. **AAD binds scope + type** -- swapping a ciphertext into a different scope or secret_type fails GCM verification.
3. **Plaintext never leaves dispatch RAM** -- file-based placers go to per-session tmpfs only; `LocalCompute + direct` is env-var-only and rejected pre-decryption otherwise.
