/**
 * The shared "nothing is dropped in silence" issue model.
 *
 * Both on-ramps that turn an outside artifact into a template draft — the Docker
 * Compose importer (`compose-import.ts`) and the template export/import codec
 * (`template-transfer.ts`) — report everything they can't carry across verbatim
 * rather than discarding it quietly. They share this one issue vocabulary so the
 * client can render both with a single component and the two can't drift.
 */

/** How much a user needs to care about a given issue. */
export type ImportIssueLevel =
  /** The file can't be imported at all. */
  | 'error'
  /** Recognised, but has no equivalent here — it was NOT carried across. */
  | 'unsupported'
  /** Carried across, but not exactly as written. */
  | 'lossy'
  /** Left unsaid; we had to pick something. */
  | 'defaulted';

export interface ImportIssue {
  level: ImportIssueLevel;
  /** Where in the source document, e.g. `services.web.build` or `version.nats.subjectPrefix`. */
  path: string;
  message: string;
}
