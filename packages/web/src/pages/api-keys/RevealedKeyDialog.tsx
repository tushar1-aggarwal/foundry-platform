/**
 * Takeover modal that reveals a freshly-minted API key plaintext.
 *
 * Critical UX invariant: plaintext is shown EXACTLY once, only here, and
 * the user must explicitly acknowledge ("I've saved this key") to dismiss.
 * Esc / outside-click do NOT dismiss -- the cookie-tossing-style risk
 * here is the user reflexively closing and losing the key. After
 * dismiss, the value is gone from the React tree forever; the only way
 * to get it back is to revoke + mint a new one.
 *
 * The plaintext is NOT logged, NOT persisted, NOT copied to localStorage,
 * NOT sent over any side-channel. The only escape paths are:
 *   - The Clipboard API (user-initiated copy click)
 *   - The user's eyes (manual copy-paste)
 */
import { useState } from "react";
import { Button } from "../../components/ui/button.js";

interface RevealedKeyDialogProps {
  /** The plaintext key returned from `apikey/create`. */
  plaintext: string;
  /** The persisted row id (e.g. `ak-c0565083`) for display only. */
  keyId: string;
  /** Called only when the user explicitly clicks "I've saved this key". */
  onDismiss: () => void;
}

export function RevealedKeyDialog({ plaintext, keyId, onDismiss }: RevealedKeyDialogProps) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(plaintext);
      setCopied(true);
      setCopyError(null);
      // Don't reset `copied` on a timer -- the user only sees the
      // success state once before dismissing. A reset would suggest
      // the copy failed.
    } catch (e) {
      setCopyError(e instanceof Error ? e.message : "copy failed");
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="revealed-key-title"
      // Full-screen takeover. No outside-click handler -- dismissal must
      // go through the explicit button below.
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
    >
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg shadow-xl max-w-lg w-full mx-4 p-6">
        <h2 id="revealed-key-title" className="text-lg font-semibold mb-2 text-[var(--fg)]">
          Your new API key
        </h2>
        <p className="text-sm text-[var(--fg-muted)] mb-4">
          This is the only time the full key will be shown. Copy it now and store it somewhere safe (your password
          manager, a secure note, etc.). If you lose it, you&apos;ll need to revoke this key and mint a new one.
        </p>

        <div className="text-xs text-[var(--fg-muted)] font-[family-name:var(--font-mono-ui)] mb-1">
          Key id: {keyId}
        </div>

        <div className="bg-[var(--bg)] border border-[var(--border)] rounded p-3 font-[family-name:var(--font-mono)] text-[12px] break-all select-all mb-3">
          {plaintext}
        </div>

        <div className="flex items-center gap-2 mb-5">
          <Button type="button" variant="secondary" onClick={handleCopy}>
            {copied ? "Copied!" : "Copy to clipboard"}
          </Button>
          {copyError && (
            <span className="text-sm text-destructive">Copy failed: {copyError} (select the text manually)</span>
          )}
        </div>

        <Button type="button" onClick={onDismiss} className="w-full">
          I&apos;ve saved this key
        </Button>
      </div>
    </div>
  );
}
