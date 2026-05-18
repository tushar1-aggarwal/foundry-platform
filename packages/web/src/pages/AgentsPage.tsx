import { useCallback, useState } from "react";
import { Layout } from "../components/Layout.js";
import { PageShell } from "../components/PageShell.js";
import { AgentsView } from "../components/AgentsView.js";
import type { AgentsSubTab } from "../components/agents/SubTabBar.js";
import { Button } from "../components/ui/button.js";

interface AgentsPageProps {
  view: string;
  onNavigate: (view: string) => void;
  readOnly: boolean;
  initialSelectedId?: string | null;
  onSelectedChange?: (id: string | null) => void;
  tab?: string | null;
  onTabChange?: (tab: string | null) => void;
}

export function AgentsPage({
  view,
  onNavigate,
  readOnly,
  initialSelectedId,
  onSelectedChange,
  tab,
  onTabChange,
}: AgentsPageProps) {
  const [showNew, setShowNew] = useState(false);

  const subTab: AgentsSubTab = tab === "runtimes" ? "runtimes" : "roles";
  const handleSubTabChange = useCallback(
    (next: AgentsSubTab) => {
      onTabChange?.(next === "roles" ? null : next);
    },
    [onTabChange],
  );

  return (
    <Layout view={view} onNavigate={onNavigate} readOnly={readOnly}>
      <PageShell
        title="Agents"
        padded={false}
        headerRight={
          !readOnly ? (
            <Button size="sm" onClick={() => setShowNew(true)}>
              + New Agent
            </Button>
          ) : undefined
        }
      >
        <AgentsView
          showCreate={showNew}
          onCloseCreate={() => setShowNew(false)}
          initialSelectedName={initialSelectedId}
          onSelectedChange={onSelectedChange}
          subTab={subTab}
          onSubTabChange={handleSubTabChange}
        />
      </PageShell>
    </Layout>
  );
}
