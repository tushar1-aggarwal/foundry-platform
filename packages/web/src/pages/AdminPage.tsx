import { useState } from "react";
import { Layout } from "../components/Layout.js";
import { PageShell } from "../components/PageShell.js";
import { ContentTabs, TabPanel } from "../components/ui/ContentTabs.js";
import { TenantsTab } from "../components/admin/TenantsTab.js";
import { TeamsTab } from "../components/admin/TeamsTab.js";
import { UsersTab } from "../components/admin/UsersTab.js";
import { ScopingTab } from "../components/admin/ScopingTab.js";
import { useOptionalAuth } from "../auth/AuthContext.js";
import type { DaemonStatus } from "../hooks/useDaemonStatus.js";

interface AdminPageProps {
  view: string;
  onNavigate: (view: string) => void;
  readOnly: boolean;
  daemonStatus?: DaemonStatus | null;
  onToast?: (msg: string, type: string) => void;
}

/**
 * Admin Panel -- tenants, teams, users, scoping overrides.
 *
 * Plain tables + confirm dialogs on destructive actions; uses the shared
 * toast helper wired through from App.tsx. The sidebar entry is
 * role-gated in `Layout.buildNavItems`, but `#/admin` is also reachable
 * via URL paste / CMD-K palette / bookmarks / deep-link -- those paths
 * bypass the rail, so the page itself ALSO role-gates. The server
 * handler layer additionally refuses on FORBIDDEN
 * (see packages/conductor/handlers/admin.ts and admin-scoping.ts);
 * the early return here just keeps the UI from rendering four empty
 * tables and a stream of FORBIDDEN toasts to a non-admin caller.
 */
export function AdminPage({ view, onNavigate, readOnly, daemonStatus, onToast }: AdminPageProps) {
  // Hooks first so order is stable across render branches.
  const [tab, setTab] = useState<string>("tenants");
  const auth = useOptionalAuth();
  const role = auth?.identity?.role ?? null;

  if (role !== "admin") {
    return (
      <Layout view={view} onNavigate={onNavigate} readOnly={readOnly} daemonStatus={daemonStatus}>
        <PageShell title="Admin">
          <AdminAccessDenied authStatus={auth?.status ?? "anonymous"} onNavigate={onNavigate} />
        </PageShell>
      </Layout>
    );
  }

  return (
    <Layout view={view} onNavigate={onNavigate} readOnly={readOnly} daemonStatus={daemonStatus}>
      <PageShell title="Admin" padded={false}>
        <ContentTabs
          tabs={[
            { id: "tenants", label: "Tenants" },
            { id: "teams", label: "Teams" },
            { id: "users", label: "Users" },
            { id: "scoping", label: "Scoping" },
          ]}
          activeTab={tab}
          onTabChange={setTab}
        />
        <div className="flex-1 min-h-0">
          {tab === "tenants" && (
            <TabPanel tabId="tenants" className="h-full">
              <TenantsTab onToast={onToast} />
            </TabPanel>
          )}
          {tab === "teams" && (
            <TabPanel tabId="teams" className="h-full">
              <TeamsTab onToast={onToast} />
            </TabPanel>
          )}
          {tab === "users" && (
            <TabPanel tabId="users" className="h-full">
              <UsersTab onToast={onToast} />
            </TabPanel>
          )}
          {tab === "scoping" && (
            <TabPanel tabId="scoping" className="h-full">
              <ScopingTab onToast={onToast} />
            </TabPanel>
          )}
        </div>
      </PageShell>
    </Layout>
  );
}

function AdminAccessDenied({
  authStatus,
  onNavigate,
}: {
  authStatus: "checking" | "authed" | "anonymous";
  onNavigate: (view: string) => void;
}) {
  if (authStatus === "checking") {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div role="status" className="text-[12px] text-[var(--fg-muted)]">
          Checking permissions...
        </div>
      </div>
    );
  }
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="max-w-md text-center">
        <h2 className="text-base font-semibold">Admin only</h2>
        <p className="mt-2 text-[12px] text-[var(--fg-muted)]">
          The Admin panel is available to users with the <code className="font-mono">admin</code> role. Your current
          session does not have that role. If you think this is a mistake, ask your tenant administrator to update your
          membership.
        </p>
        <button
          type="button"
          onClick={() => onNavigate("sessions")}
          className="mt-4 rounded border border-[var(--border)] px-3 py-1 text-[12px] hover:bg-[var(--bg-subtle)]"
        >
          Back to Sessions
        </button>
      </div>
    </div>
  );
}
