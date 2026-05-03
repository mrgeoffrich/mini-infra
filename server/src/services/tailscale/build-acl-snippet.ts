import { TAILSCALE_DEFAULT_TAG } from "@mini-infra/types";

/**
 * Canonical ACL bootstrap snippet the operator pastes into their Tailscale
 * tailnet policy file at https://login.tailscale.com/admin/acls.
 *
 * The snippet declares:
 *   - tagOwners: who is allowed to assign / own the managed tag.
 *   - grants:    tailnet members can reach devices carrying the tag.
 *   - ssh:       tailnet members may SSH into the tagged devices, with a
 *                12-hour re-check window so Phase 3's `--ssh` flag works
 *                without further ACL edits.
 *
 * Same source of truth used by the docs page and the client form's preview;
 * exported as a pure function so it can be unit-tested in isolation.
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
