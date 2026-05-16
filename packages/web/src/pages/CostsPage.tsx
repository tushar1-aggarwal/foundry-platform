import { Layout } from "../components/Layout.js";
import { PageShell } from "../components/PageShell.js";
import { CostsView } from "../components/CostsView.js";

interface CostsPageProps {
  view: string;
  onNavigate: (view: string) => void;
  readOnly: boolean;
}

export function CostsPage({ view, onNavigate, readOnly }: CostsPageProps) {
  return (
    <Layout view={view} onNavigate={onNavigate} readOnly={readOnly}>
      <PageShell title="Costs" padded={false}>
        <CostsView />
      </PageShell>
    </Layout>
  );
}
