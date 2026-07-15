/**
 * Draft-mapping helpers used across the application Configuration tab, the
 * stack-templates draft editor, and the Code-view codec.
 *
 * The implementations were hoisted into `@mini-infra/types`
 * (`template-draft.ts`) so the server template-export endpoint can share the
 * exact same lossless version→draft conversion — one mapper, no drift. This
 * module stays as the client-facing entry point so existing `@/lib/application-draft`
 * imports keep resolving.
 */
export {
  buildDraftFromVersion,
  mapServiceInfoToDefinition,
  mapConfigFileInfoToInput,
  stripNull,
} from "@mini-infra/types";
