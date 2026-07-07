/**
 * Describes the sections of the application edit form for the settings-rail
 * layout. Kept free of React/JSX so the error- and ordering-mapping helpers
 * below can be unit-tested in isolation. The rail component maps `id` to an
 * icon; the page renders one card per descriptor in this order.
 */

export type SectionGroup = "frequent" | "network" | "once";

export interface SectionDescriptor {
  id: string;
  label: string;
  group: SectionGroup;
  /**
   * Top-level form field keys owned by this section. Used to light up the rail
   * when `react-hook-form` reports a validation error and to scroll to the
   * first offending section on a failed save.
   */
  fieldKeys: string[];
}

/** Sections in render + rail order — most-edited first, set-once last. */
export const EDIT_SECTIONS: SectionDescriptor[] = [
  {
    id: "image",
    label: "Image & version",
    group: "frequent",
    fieldKeys: ["dockerImage", "dockerTag"],
  },
  {
    id: "environment",
    label: "Environment variables",
    group: "frequent",
    fieldKeys: ["envVars"],
  },
  {
    id: "networking",
    label: "Networking",
    group: "network",
    fieldKeys: ["ports", "routing", "enableRouting"],
  },
  {
    id: "storage",
    label: "Storage",
    group: "network",
    fieldKeys: ["volumeMounts"],
  },
  {
    id: "runtime",
    label: "Runtime & advanced",
    group: "once",
    fieldKeys: ["serviceType", "restartPolicy", "enableHealthCheck", "healthCheck"],
  },
  {
    id: "identity",
    label: "Identity",
    group: "once",
    fieldKeys: ["displayName", "description", "serviceName"],
  },
];

export const SECTION_GROUP_LABELS: Record<SectionGroup, string> = {
  frequent: "Frequently edited",
  network: "Networking & storage",
  once: "Set once",
};

/** DOM id for a section's anchor card, used for scroll-to and scroll-spy. */
export function sectionAnchorId(id: string): string {
  return `app-config-section-${id}`;
}

/**
 * Given the top-level keys of `form.formState.errors`, return the ids of
 * sections that own at least one errored field.
 */
export function computeSectionErrors(
  errorKeys: string[],
  sections: SectionDescriptor[] = EDIT_SECTIONS,
): Set<string> {
  const errored = new Set(errorKeys);
  const result = new Set<string>();
  for (const section of sections) {
    if (section.fieldKeys.some((key) => errored.has(key))) {
      result.add(section.id);
    }
  }
  return result;
}

/**
 * The id of the first section (in render order) that owns an errored field, or
 * `null` when nothing is errored. Drives scroll-to-error on a failed save.
 */
export function firstErroredSectionId(
  errorKeys: string[],
  sections: SectionDescriptor[] = EDIT_SECTIONS,
): string | null {
  const errored = new Set(errorKeys);
  for (const section of sections) {
    if (section.fieldKeys.some((key) => errored.has(key))) {
      return section.id;
    }
  }
  return null;
}
