import { TAILSCALE_DEFAULT_TAG } from "@mini-infra/types";

/**
 * Canonical Tailscale ACL bootstrap snippet for the operator to paste into
 * their tailnet policy file at https://login.tailscale.com/admin/acls.
 *
 * Mirrors the server-side helper at
 * `server/src/services/tailscale/build-acl-snippet.ts`. Both sides need to
 * render the same JSON: the form's live preview (here) and the docs route
 * (server). Keeping the function pure means the live preview re-renders on
 * every keystroke without a server round-trip, and the unit tests pin the
 * output shape so the two helpers can't drift silently.
 */
export function buildAclSnippet(extraTags: string[] = []): string {
  const tags = [TAILSCALE_DEFAULT_TAG, ...extraTags];
  const acl = {
    tagOwners: Object.fromEntries(tags.map((t) => [t, ["autogroup:admin"]])),
    grants: [
      {
        src: ["autogroup:member"],
        dst: tags,
        ip: ["*"],
      },
    ],
    ssh: [
      {
        action: "check",
        src: ["autogroup:member"],
        dst: tags,
        users: ["root", "autogroup:nonroot"],
        checkPeriod: "12h",
      },
    ],
  };
  return JSON.stringify(acl, null, 2);
}
