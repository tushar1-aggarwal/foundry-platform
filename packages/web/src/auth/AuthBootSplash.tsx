/**
 * Loading splash shown while AuthProvider is in the `checking` state --
 * i.e. between page mount and the first `auth/whoami` resolution.
 *
 * Distinct from `<PageFallback />`, which is intentionally invisible to
 * avoid flashing on fast page transitions. This splash is meant to be
 * SEEN: it covers the genuine ~700ms-1.5s gap between Google's OAuth
 * redirect landing on `/` and the dashboard rendering, which without
 * any feedback feels like the app is broken.
 *
 * The splash also covers the cold-tab case (returning user with a valid
 * cookie). Their whoami round-trip is shorter (~200ms) so the splash
 * may flash by, which is fine.
 */
export function AuthBootSplash() {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Signing you in"
      className="min-h-screen bg-background flex items-center justify-center"
    >
      <div className="flex flex-col items-center gap-4">
        <h1 className="text-2xl font-bold text-foreground">Ark</h1>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span aria-hidden="true" className="inline-block w-2 h-2 rounded-full bg-[var(--primary)] animate-pulse" />
          <span>Signing you in...</span>
        </div>
      </div>
    </div>
  );
}
