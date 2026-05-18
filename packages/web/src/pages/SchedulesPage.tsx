import { useState } from "react";
import { Plus } from "lucide-react";
import { Layout } from "../components/Layout.js";
import { PageShell } from "../components/PageShell.js";
import { ScheduleView } from "../components/ScheduleView.js";
import { Button } from "../components/ui/button.js";

interface SchedulesPageProps {
  view: string;
  onNavigate: (view: string) => void;
  readOnly: boolean;
}

export function SchedulesPage({ view, onNavigate, readOnly }: SchedulesPageProps) {
  const [showNew, setShowNew] = useState(false);

  return (
    <Layout view={view} onNavigate={onNavigate} readOnly={readOnly}>
      <PageShell
        title="Schedules"
        padded={false}
        headerRight={
          !readOnly ? (
            <Button size="sm" onClick={() => setShowNew(true)}>
              <Plus size={14} />
              New Schedule
            </Button>
          ) : undefined
        }
      >
        <ScheduleView showCreate={showNew} onCloseCreate={() => setShowNew(false)} />
      </PageShell>
    </Layout>
  );
}
