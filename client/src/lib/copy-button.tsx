import { useState } from "react";
import { IconCopy, IconCheck } from "@tabler/icons-react";

export const CopyButton = ({ text }: { text: string }) => {
  const [copied, setCopied] = useState(false);

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error("Failed to copy to clipboard:", error);
    }
  };

  return (
    <button
      onClick={copyToClipboard}
      className="flex items-center gap-1 px-2 py-1 text-xs bg-gray-100 hover:bg-gray-200 rounded text-black border border-gray-300 transition-colors"
      title="Copy to clipboard"
    >
      {copied ? (
        <>
          <IconCheck size={12} />
          <span>Copied!</span>
        </>
      ) : (
        <>
          <IconCopy size={12} />
          <span>Copy</span>
        </>
      )}
    </button>
  );
};
