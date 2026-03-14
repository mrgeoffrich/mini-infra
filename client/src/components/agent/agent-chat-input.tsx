import { useState, useRef, useCallback, type KeyboardEvent } from "react";
import { IconSend, IconPlayerStopFilled } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { useAgentChat } from "@/hooks/use-agent-chat";

export function AgentChatInput() {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { sendMessage, stopSession, sessionStatus } = useAgentChat();
  const disabled = sessionStatus === "connecting";
  const sending =
    sessionStatus === "streaming" || sessionStatus === "waiting";

  const handleSend = useCallback(async () => {
    const trimmed = value.trim();
    if (!trimmed || disabled || sending) return;
    setValue("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
    await sendMessage(trimmed);
  }, [value, disabled, sending, sendMessage]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  const handleInput = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 128) + "px";
  }, []);

  return (
    <div className="border-t px-3 py-3">
      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            handleInput();
          }}
          onKeyDown={handleKeyDown}
          placeholder={sending ? "Waiting for response..." : "Ask a question..."}
          disabled={disabled}
          rows={1}
          className="flex-1 resize-none rounded-md border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50 min-h-10 max-h-32"
        />
        {sending ? (
          <Button
            size="icon"
            variant="destructive"
            className="size-9 shrink-0"
            onClick={stopSession}
          >
            <IconPlayerStopFilled className="size-4" />
          </Button>
        ) : (
          <Button
            size="icon"
            className="size-9 shrink-0"
            onClick={handleSend}
            disabled={disabled || !value.trim()}
          >
            <IconSend className="size-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
