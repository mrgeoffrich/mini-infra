import { z } from "zod";

/**
 * Phase 6 of the Claude Shell plan — Applications page preset + create form.
 *
 * This module holds the zod schema + defaults for the
 * `/applications/new/claude-shell` create form. The form is intentionally
 * narrow (vs the generic "New Application" flow): the operator picks a name,
 * environment, optional git repo URL, optional SSH deploy key, and optional
 * extra tailnet tags — the rest of the StackTemplateRequest is derived from
 * these inputs at submission time.
 *
 * `gitDeployKey` is validated client-side only for the obvious PEM-shape so we
 * give immediate feedback; the canonical validation lives on the server (see
 * `stacks-git-deploy-key-route.ts`). The key value is held in form state, sent
 * to the PUT endpoint, then discarded — never persisted in localStorage,
 * sessionStorage, or any TanStack Query cache.
 */

const tailnetTagRegex = /^tag:[a-z0-9-]+$/;

const pemPrivateKeyRegex =
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]+-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/;

/**
 * Loose URL shape — accepts either an HTTPS URL or an `git@host:path` SSH URL.
 * Mirrors what the Phase 1 entrypoint accepts. We don't try to fully validate
 * the URL here; the entrypoint and `git` itself are the real arbiters.
 */
const gitRepoUrlRegex =
  /^(?:https?:\/\/[^\s]+|(?:git|[a-zA-Z0-9._-]+)@[^\s:]+:[^\s]+)$/;

export const claudeShellFormSchema = z.object({
  /** Human-readable name; slugified to form the stack name on submit. */
  name: z
    .string()
    .min(1, "Name is required")
    .max(63, "Name must be ≤ 63 chars"),
  /** Target environment for the stack. */
  environmentId: z.string().min(1, "Environment is required"),
  /**
   * Optional git repo URL. Either HTTPS (public) or SSH (`git@host:path`).
   * Empty string is treated as "not set" so the form's optional + zod
   * validation paths agree.
   */
  gitRepo: z
    .string()
    .max(1024)
    .optional()
    .refine(
      (val) => !val || gitRepoUrlRegex.test(val),
      "Must be an HTTPS URL or `user@host:path` SSH URL",
    ),
  /**
   * Optional PEM-encoded private key for git over SSH. Cleared on success;
   * never round-tripped through any cache. Allowed only when `gitRepo` is set.
   */
  gitDeployKey: z
    .string()
    .max(64 * 1024)
    .optional()
    .refine(
      (val) => !val || pemPrivateKeyRegex.test(val),
      "Does not look like a PEM-encoded private key (expected -----BEGIN ... PRIVATE KEY----- / -----END ... PRIVATE KEY----- markers)",
    ),
  /**
   * Optional comma-separated tag list. Each entry must match `tag:[a-z0-9-]+`.
   * Layered on top of the static `tag:mini-infra-managed` default in the
   * addon framework.
   */
  extraTagsRaw: z
    .string()
    .optional()
    .refine((val) => {
      if (!val) return true;
      const tags = val
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
      return tags.every((t) => tailnetTagRegex.test(t));
    }, "Each tag must match `tag:[a-z0-9-]+` (e.g. tag:dev-team)"),
});

export type ClaudeShellFormData = z.infer<typeof claudeShellFormSchema>;

export const claudeShellFormDefaults: ClaudeShellFormData = {
  name: "",
  environmentId: "",
  gitRepo: "",
  gitDeployKey: "",
  extraTagsRaw: "",
};

/**
 * Slugify a human-readable name to a stack-name-safe slug. Matches the same
 * shape `serviceNameSchema` accepts in `application-schemas.ts` so the
 * derived name passes server-side validation:
 *
 *   - lowercased
 *   - non-alnum runs collapsed to single hyphens
 *   - trimmed of leading/trailing hyphens
 *   - truncated to 63 chars
 */
export function slugifyClaudeShellName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 63);
}

/**
 * Split the comma-separated tag string into a clean array. Returns `undefined`
 * when no tags were supplied — keeps the rendered addon block's `extraTags`
 * absent (rather than `[]`) so the addon's schema sees the field as
 * not-provided.
 */
export function parseExtraTags(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const tags = raw
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  return tags.length > 0 ? tags : undefined;
}

/**
 * The published image reference used by the preset. Centralised here so the
 * tile, the form, the help copy, and any future SSR/SEO surface read from a
 * single place. The tag `latest` aligns with how `mini-infra-sidecar` and
 * `mini-infra-agent-sidecar` are deployed off the published GHCR image.
 */
export const CLAUDE_SHELL_IMAGE = "ghcr.io/mrgeoffrich/mini-infra-claude-shell";
export const CLAUDE_SHELL_DEFAULT_TAG = "latest";

/**
 * Service-name baked into the preset. Kept stable so:
 *   - the Connect-panel SSH row finds it (`mini-infra.addon: claude-shell`
 *     label is set by the framework on this service),
 *   - the git-deploy-key PUT path is predictable: `/api/stacks/:stackId/services/shell/git-deploy-key`,
 *   - the entrypoint volume layout lines up with operator expectations.
 */
export const CLAUDE_SHELL_SERVICE_NAME = "shell";
