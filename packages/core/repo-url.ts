/**
 * Does this string look like a remote git URL rather than a local filesystem
 * path? Used by dispatch / worktree / executor code to avoid feeding URLs to
 * `path.resolve()` (which produces nonsense like `/cwd/https:/host/...`) and
 * to gate remote-clone behaviour.
 *
 * Covered schemes: `https://`, `http://`, `git://`, `ssh://`, and the SCP-like
 * `git@host:owner/repo` shorthand.
 */
export function isRepoUrl(s: string): boolean {
  return /^(https?:\/\/|git:\/\/|ssh:\/\/|git@)/.test(s);
}
