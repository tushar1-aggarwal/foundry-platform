# Hierarchical Secrets -- End-to-End Flow Diagrams

Companion to `2026-05-13-hierarchical-secrets-design.md`. Shows how a development task moves through Ark's autonomous SDLC flow with secrets resolving across tenant / team / user scopes.

---

## 1. Architecture overview

Who writes secrets, where they land, and how key custody splits from the encrypted data store.

```mermaid
flowchart LR
    subgraph Onb["Onboarding (one-time per actor)"]
        direction TB
        TA["<b>Tenant Admin</b><br/><i>ark onboard tenant</i><br/>seeds tenant-scope keys"]
        TmA["<b>Team Admin</b><br/><i>ark onboard team &lt;id&gt;</i><br/>seeds team-scope keys"]
        Usr["<b>User</b><br/><i>ark onboard user</i><br/>seeds personal keys"]
    end

    subgraph Svc["arkd: SecretsService"]
        API["PUT /secrets/bindings<br/>canWrite() per body"]
        Reg["secret_keys_registry<br/>policy + required_at_scope"]
    end

    subgraph Store["Postgres / SQLite"]
        SR["secret_refs<br/>AES-GCM ciphertext<br/>+ nonce + tag + AAD fp"]
        SB["secret_bindings<br/>(tenant, scope_kind,<br/>scope_id, key) -> ref"]
        TD["tenant_deks<br/>per-tenant DEK,<br/>wrapped by master KEK"]
        AL["secret_audit_log<br/>every write + every resolve"]
    end

    subgraph Custody["Key custody (NOT in DB)"]
        ENV["ARK_MASTER_KEY env var<br/>injected by orchestrator<br/>(k8s Secret / systemd creds /<br/>Vault Agent sidecar)"]
        KEK["master KEK<br/>SecureBuffer in arkd RAM<br/>loaded once at startup"]
    end

    TA -->|"set tenant secrets"| API
    TmA -->|"set team secrets"| API
    Usr -->|"set personal secrets"| API

    API --> Reg
    API -->|"encrypt(value, tenant DEK)<br/>AAD = tenant_id || scope_kind ||<br/>scope_id || key || secret_type"| SR
    API --> SB
    API --> AL

    ENV --> KEK
    KEK -->|"unwrap on first use<br/>cache in RAM"| TD
    TD -->|"per-tenant DEK"| API

    classDef onb fill:#fef3c7,stroke:#92400e
    classDef svc fill:#e0e7ff,stroke:#3730a3
    classDef store fill:#d1fae5,stroke:#065f46
    classDef custody fill:#fee2e2,stroke:#991b1b
    class TA,TmA,Usr onb
    class API,Reg svc
    class SR,SB,TD,AL store
    class ENV,KEK custody
```

**Key property:** the master KEK lives outside the data store. A leaked `pg_dump` alone is useless -- the attacker has ciphertexts and wrapped DEKs but no way to unwrap them without the env var.

---

## 2. Session dispatch + SDLC execution

What happens when a user triggers an `autonomous-sdlc` flow. The effective secret set is computed once at dispatch and feeds the placer pipeline. The agent then runs through SDLC stages with each stage consuming the secrets it needs.

```mermaid
flowchart TB
    Trigger["<b>User triggers SDLC task</b><br/><i>ark run autonomous-sdlc --repo X</i>"]
    Sess["Session created<br/>tenant_id + user_id + team_chain<br/>(team_chain from sessions_auth)"]

    Trigger --> Sess

    subgraph Resolve["effectiveSecretsForSession"]
        direction TB
        ListKeys["listKeysForScope(ctx, sessionScope)<br/>union of keys reachable from this scope"]
        Walk["For each key, walk:<br/>1. user binding<br/>2. team_chain[0..N] (most specific first)<br/>3. tenant binding<br/>Per-key policy: 'locked' -> tenant only,<br/>'overridable' -> first-hit wins"]
        Fetch["For each hit:<br/>unwrap tenant DEK,<br/>decrypt blob,<br/>verify AAD"]

        ListKeys --> Walk --> Fetch
    end

    Sess --> Resolve

    Resolve --> Effective["<b>Effective Typed Secret Set</b><br/>e.g. for user u_alice in team_platform:<br/>- ANTHROPIC_API_KEY (tenant)<br/>- GITHUB_TOKEN (user override)<br/>- SSH_PRIVATE_KEY (user)<br/>- NPM_TOKEN (team)<br/>- KUBECONFIG (team)<br/>- AWS_ACCESS_KEY_ID (tenant)"]

    subgraph Place["placeAllSecrets (per-type placers)"]
        direction TB
        EV["env-var placer<br/>ctx.setEnv(name, value)"]
        SSH["ssh-private-key placer<br/>tmpfs: ~/.ssh/id_*<br/>+ ssh/config + known_hosts"]
        KC["kubeconfig placer<br/>tmpfs: ~/.kube/config<br/>+ KUBECONFIG env"]
        GB["generic-blob placer<br/>tmpfs: configured path"]
    end

    Effective --> Place

    subgraph Stages["Agent runtime: autonomous-sdlc DAG (flows/definitions/autonomous-sdlc.yaml)"]
        direction LR
        S1["<b>plan</b> (planner agent)<br/>analyse summary, write PLAN.md<br/>uses: GITHUB_TOKEN (user) to read context<br/>ANTHROPIC_API_KEY (tenant) for LLM"]
        S2["<b>implement</b> (implementer agent)<br/>follow PLAN.md, write code+tests<br/>uses: SSH_PRIVATE_KEY (user) for git<br/>NPM_TOKEN (team) for installs<br/>ANTHROPIC_API_KEY (tenant) for LLM"]
        S3["<b>verify</b> (verifier agent)<br/>tests + lint + security + ACs<br/>uses: team DB creds<br/>ANTHROPIC_API_KEY (tenant) for LLM"]
        S4["<b>review</b> (reviewer agent)<br/>diff review for correctness/quality<br/>uses: ANTHROPIC_API_KEY (tenant) for LLM<br/>GITHUB_TOKEN (user) to read diff"]
        S5["<b>pr</b> (create_pr action)<br/>open PR on the branch<br/>uses: GITHUB_TOKEN (user)<br/>-> PR attributed to user"]
        S6["<b>merge</b> (auto_merge action)<br/>auto-merge after review<br/>uses: GITHUB_TOKEN (user)<br/>with merge permission"]

        S1 --> S2 --> S3 --> S4 --> S5 --> S6
    end

    Place --> Stages

    Stages --> Done["<b>Session end</b>"]

    subgraph Cleanup["On session end"]
        direction TB
        Aud["audit rows persisted<br/>(per-resolve + per-write)"]
        Tmp["tmpfs unmounted<br/>RAM-backed FS bytes reclaimed"]
        Mem["arkd plaintext cache evicted<br/>SecureBuffer dispose"]
    end

    Done --> Cleanup

    classDef trigger fill:#fef3c7,stroke:#92400e
    classDef resolve fill:#e0e7ff,stroke:#3730a3
    classDef place fill:#dbeafe,stroke:#1e40af
    classDef stage fill:#d1fae5,stroke:#065f46
    classDef cleanup fill:#fee2e2,stroke:#991b1b
    class Trigger,Sess trigger
    class ListKeys,Walk,Fetch,Effective resolve
    class EV,SSH,KC,GB place
    class S1,S2,S3,S4,S5,S6 stage
    class Aud,Tmp,Mem cleanup
```

**Stage names match `flows/definitions/autonomous-sdlc.yaml`** (plan -> implement -> verify -> review -> pr -> merge). Per-stage secret use is illustrative: what each stage touches is determined by the agent definition + runtime YAML, not by a hardcoded mapping. The resolver hands the agent the full effective set; the agent uses whichever vars it needs at each stage.

---

## 3. Resolution algorithm (per key)

Decision tree the resolver walks for each registered key when computing the effective set. Applied independently for every key the agent might need.

```mermaid
flowchart TD
    Start(["Need key K<br/>for session in tenant T,<br/>user U, team_chain [Tm1, Tm2, ...]"])

    Pol{"Registry policy<br/>for (T, K)?"}

    Start --> Pol

    Pol -->|"locked"| LockedT{"tenant binding<br/>(T, T, K)?"}
    Pol -->|"overridable<br/>or unregistered"| UserB{"user binding<br/>(T, U, K)?"}

    UserB -->|yes| RetU(["return user value"])
    UserB -->|no| Team1{"team binding<br/>(T, Tm1, K)?"}

    Team1 -->|yes| RetTm1(["return Tm1 value"])
    Team1 -->|no| TeamN{"walk Tm2..TmN<br/>(parent teams)"}

    TeamN -->|hit at Tmi| RetTmi(["return Tmi value"])
    TeamN -->|no hit| TenantO{"tenant binding<br/>(T, T, K)?"}

    TenantO -->|yes| RetTen(["return tenant value"])
    TenantO -->|no| Null(["return null<br/>placer skips this key"])

    LockedT -->|yes| RetTen2(["return tenant value"])
    LockedT -->|no| Null2(["return null"])

    classDef ret fill:#d1fae5,stroke:#065f46
    classDef null fill:#fee2e2,stroke:#991b1b
    classDef dec fill:#e0e7ff,stroke:#3730a3
    class RetU,RetTm1,RetTmi,RetTen,RetTen2 ret
    class Null,Null2 null
    class Pol,UserB,Team1,TeamN,TenantO,LockedT dec
```

**Locked vs overridable rationale:**
- `locked` is for compliance-sensitive keys where the tenant must dictate the value (e.g., the tenant's official Anthropic billing key when finance requires it).
- `overridable` is the default: most-specific scope wins, with sensible fallbacks. Lets a user's personal `GITHUB_TOKEN` shadow the team's bot token so commits attribute correctly.

---

## 4. Trust boundaries at a glance

Where each piece of material lives and what would have to be compromised to leak plaintext.

```mermaid
flowchart LR
    subgraph DB["Postgres / SQLite"]
        CT["ciphertexts<br/>(secret_refs)"]
        WD["wrapped DEKs<br/>(tenant_deks)"]
    end

    subgraph Orch["Orchestrator (k8s, systemd, Vault)"]
        MK["ARK_MASTER_KEY<br/>injected to arkd env"]
    end

    subgraph Daemon["arkd process RAM"]
        KEK["master KEK<br/>SecureBuffer"]
        DEKc["unwrapped tenant DEKs<br/>cached for daemon lifetime"]
        PTc["plaintext cache<br/>TTL 300s during dispatch"]
    end

    subgraph Agent["Agent runtime (per session)"]
        EV["env vars in agent process"]
        TF["tmpfs files<br/>(RAM-backed)"]
    end

    MK --> KEK
    CT -.->|"+ KEK + DEK"| PTc
    WD -.->|"+ KEK"| DEKc
    DEKc -.-> PTc
    PTc --> EV
    PTc --> TF

    subgraph Leak["Attack -> what leaks"]
        L1["pg_dump only -> nothing useful"]
        L2["pg_dump + ARK_MASTER_KEY -> everything"]
        L3["arkd memory dump -> in-flight secrets + KEK + DEKs"]
        L4["agent process compromise -> that session's secrets only"]
    end

    classDef db fill:#d1fae5,stroke:#065f46
    classDef orch fill:#fef3c7,stroke:#92400e
    classDef daemon fill:#e0e7ff,stroke:#3730a3
    classDef agent fill:#dbeafe,stroke:#1e40af
    classDef leak fill:#fee2e2,stroke:#991b1b
    class CT,WD db
    class MK orch
    class KEK,DEKc,PTc daemon
    class EV,TF agent
    class L1,L2,L3,L4 leak
```

**Read this as a defense-in-depth statement:** an attacker needs two of {DB access, orchestrator-managed env, arkd process memory, agent runtime} to escalate. Single-layer compromises are contained.

---

## 5. Concrete walkthrough -- a real session

Alice is a user in tenant `acme`, member of teams `[platform, eng]`. She triggers `ark run autonomous-sdlc --repo github.com/acme/api --issue 142`.

**Registry state (set during onboarding):**
| Key | Policy | Required at |
|---|---|---|
| `ANTHROPIC_API_KEY` | overridable | tenant |
| `GITHUB_TOKEN` | overridable | user |
| `SSH_PRIVATE_KEY` | overridable | user |
| `NPM_TOKEN` | overridable | team |
| `KUBECONFIG` | overridable | team |
| `AWS_ACCESS_KEY_ID` | locked | tenant |
| `AWS_SECRET_ACCESS_KEY` | locked | tenant |

**Bindings in the DB:**

| Scope | Key | Set by |
|---|---|---|
| tenant=acme | ANTHROPIC_API_KEY | tenant admin |
| tenant=acme | AWS_ACCESS_KEY_ID | tenant admin |
| tenant=acme | AWS_SECRET_ACCESS_KEY | tenant admin |
| team=platform | NPM_TOKEN | platform team admin |
| team=platform | KUBECONFIG | platform team admin |
| team=eng | GITHUB_TOKEN | eng team admin (org bot PAT) |
| user=alice | GITHUB_TOKEN | alice (personal PAT) |
| user=alice | SSH_PRIVATE_KEY | alice |

**Resolver output for Alice's session:**

| Key | Resolved to | Why |
|---|---|---|
| ANTHROPIC_API_KEY | tenant value | no user/team override |
| AWS_ACCESS_KEY_ID | tenant value | locked policy -> tenant only |
| AWS_SECRET_ACCESS_KEY | tenant value | locked policy -> tenant only |
| GITHUB_TOKEN | **alice's personal PAT** | user binding shadows team bot |
| SSH_PRIVATE_KEY | alice's key | only user binding exists |
| NPM_TOKEN | platform team value | most-specific team in chain |
| KUBECONFIG | platform team value | most-specific team in chain |

**Audit emits during this session:**
- 1x `kind=system, action=resolve` per key (7 rows) on dispatch.
- 1x audit row at session end summarizing source mix.
- 0x writes -- this session only reads.

**Commit attribution:** PR opened in stage `pr` (and auto-merged in stage `merge`) carries Alice's identity because the user-scope `GITHUB_TOKEN` shadowed the team bot. Audit trail proves the agent used Alice's credentials, not the bot.

---

## Notes on rendering

These diagrams are Mermaid. They render natively in:
- GitHub (web + mobile)
- VS Code with the Mermaid preview extension
- Most modern markdown viewers (Obsidian, Notion, etc.)

For a hand-drawn / sketchy look closer to Excalidraw, the Mermaid theme can be set to `handDrawn` via a directive:

```text
%%{init: {'theme':'base', 'themeVariables': {'primaryColor':'#fff'}, 'flowchart': {'curve':'basis'}}}%%
```

If a true Excalidraw `.excalidraw` JSON is preferred (for direct editing on excalidraw.com), these can be hand-converted -- ping for that round-trip.
