import { z } from "zod";

/**
 * Structural NATS subject shapes shared by every authoring surface.
 *
 * Lives in its own module to break what was otherwise a circular import:
 * `schemas.ts` defines the JobPool trigger schema (which needs a NATS-subject
 * shape) and `stack-template-schemas.ts` defines the role-nested NATS section
 * (which also needs the same shape), and stack-template-schemas already
 * imports from schemas. Lifting the subject regex + refines here lets both
 * consumers import from a neutral location so a future tightening can't
 * silently miss one path.
 *
 * Runtime concerns (prefix-allowlist enforcement, subject-prefix prepending,
 * cross-stack export bindings) layer on top of these structural rules in
 * `nats-prefix-allowlist-service.ts` and the apply orchestrator — this file
 * is purely the structural-validation layer.
 */

/**
 * Subjects in app-author roles[].publish/subscribe (and JobPool nats-request
 * trigger subjects) are *relative* to the stack's subjectPrefix; the
 * orchestrator prepends. Wildcards inside the relative path are fine; what's
 * forbidden is breaking out of the prefix or hitting reserved namespaces.
 *
 * Static rules:
 *   - cannot start with `>` or `*` (would shadow whole prefix tree)
 *   - cannot start with `_INBOX.` (use inboxAuto instead)
 *   - cannot start with `$SYS.` (system-account namespace)
 *   - cannot contain `..` or empty tokens
 */
export const natsRelativeSubjectSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(
    /^[A-Za-z0-9_*>\-.]+$/,
    "subject must contain only letters, numbers, '_', '-', '.', '*', '>'",
  )
  .refine((s) => !s.startsWith(">") && !s.startsWith("*"), {
    message:
      "subject must not start with a wildcard ('>' or '*') — that would shadow the entire stack prefix",
  })
  .refine((s) => !s.startsWith("_INBOX."), {
    message:
      "subject must not target '_INBOX.>' directly — use the inboxAuto field on the role",
  })
  .refine((s) => !s.startsWith("$SYS.") && s !== "$SYS", {
    message:
      "subject must not target the '$SYS.>' system-account namespace",
  })
  .refine(
    (s) =>
      !s.includes("..") && !s.split(".").some((tok) => tok.length === 0),
    {
      message:
        "subject must not contain empty tokens ('..' or leading/trailing dots)",
    },
  );
