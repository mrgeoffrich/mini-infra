import React from "react";
import { Button } from "@/components/ui/button";

interface CopyButtonProps {
  text: string;
  className?: string;
}

export const CopyButton = React.memo(
  ({ text, className = "h-6 w-6 p-0" }: CopyButtonProps) => {
    const handleCopy = React.useCallback(async () => {
      try {
        await navigator.clipboard.writeText(text);
      } catch (err) {
        console.error("Failed to copy text: ", err);
      }
    }, [text]);

    return (
      <Button
        variant="ghost"
        size="sm"
        onClick={handleCopy}
        className={className}
        title={`Copy ${text}`}
      >
        <span className="sr-only">Copy {text}</span>
      </Button>
    );
  },
  (prevProps, nextProps) =>
    prevProps.text === nextProps.text &&
    prevProps.className === nextProps.className,
);

CopyButton.displayName = "CopyButton";
