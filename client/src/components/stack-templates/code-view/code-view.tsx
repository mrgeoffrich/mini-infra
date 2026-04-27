import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { yaml as yamlLang } from "@codemirror/lang-yaml";
import { oneDark } from "@codemirror/theme-one-dark";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { IconAlertCircle, IconLoader2 } from "@tabler/icons-react";
import type {
  DraftVersionInput,
  StackTemplateVersionInfo,
} from "@mini-infra/types";
import {
  parseYamlToDraft,
  serializeVersionToYaml,
} from "./yaml-codec";

interface CodeViewProps {
  version: StackTemplateVersionInfo | undefined;
  readOnly: boolean;
  saving: boolean;
  onSave: (draft: DraftVersionInput) => Promise<void>;
}

/**
 * YAML editor for the entire draft version. Changes are buffered locally and
 * pushed with explicit Save — switching away from the code view while the
 * buffer is dirty drops the edits (caller warns about it).
 */
export function CodeView({ version, readOnly, saving, onSave }: CodeViewProps) {
  const initialYaml = useMemo(
    () => (version ? serializeVersionToYaml(version) : ""),
    [version],
  );

  const [buffer, setBuffer] = useState(initialYaml);
  const [parseError, setParseError] = useState<string | null>(null);
  const [parseErrorLine, setParseErrorLine] = useState<number | undefined>(undefined);

  // Refresh the buffer whenever the upstream version changes (version switch
  // or post-save refresh). Assumes the caller won't swap the version mid-edit.
  // Routed through a ref so the effect body doesn't call setState directly
  // (avoids set-state-in-effect).
  const syncFromUpstream = useCallback(() => {
    setBuffer(initialYaml);
    setParseError(null);
  }, [initialYaml]);
  const syncFromUpstreamRef = useRef(syncFromUpstream);
  useEffect(() => {
    syncFromUpstreamRef.current = syncFromUpstream;
  }, [syncFromUpstream]);
  useEffect(() => {
    syncFromUpstreamRef.current();
  }, [initialYaml]);

  const dirty = buffer !== initialYaml;

  // Detect the system/prefers-color-scheme to pick a theme. The rest of the
  // app uses Tailwind dark: classes; one-dark reads "looks right enough" on
  // both backgrounds when the editor chrome matches the shadcn surface.
  const isDark =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-color-scheme: dark)").matches;

  async function handleSave() {
    const parsed = parseYamlToDraft(buffer);
    if (!parsed.ok) {
      setParseError(parsed.error);
      setParseErrorLine(parsed.line);
      return;
    }
    setParseError(null);
    setParseErrorLine(undefined);
    await onSave(parsed.value);
  }

  function handleReset() {
    setBuffer(initialYaml);
    setParseError(null);
    setParseErrorLine(undefined);
  }

  return (
    <div className="flex h-full flex-col gap-3">
      {parseError && (
        <Alert variant="destructive">
          <IconAlertCircle className="h-4 w-4" />
          <AlertDescription>
            {parseErrorLine !== undefined
              ? `Line ${parseErrorLine}: ${parseError}`
              : parseError}
          </AlertDescription>
        </Alert>
      )}

      <div className="flex-1 overflow-hidden rounded-md border bg-background">
        <CodeMirror
          value={buffer}
          extensions={[yamlLang()]}
          theme={isDark ? oneDark : "light"}
          editable={!readOnly}
          onChange={(v) => setBuffer(v)}
          basicSetup={{
            lineNumbers: true,
            foldGutter: true,
            highlightActiveLine: !readOnly,
            highlightActiveLineGutter: !readOnly,
          }}
          height="100%"
          style={{ height: "100%", fontSize: "13px" }}
        />
      </div>

      {!readOnly && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            {dirty
              ? "Unsaved changes — Save to write back to the draft."
              : "In sync with the current draft."}
          </p>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleReset}
              disabled={!dirty || saving}
            >
              Reset
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={handleSave}
              disabled={!dirty || saving}
            >
              {saving && <IconLoader2 className="h-4 w-4 mr-1 animate-spin" />}
              Save
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
