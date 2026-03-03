import { toast } from "sonner";
import { IconCopy, IconCheck } from "@tabler/icons-react";
import { useState } from "react";

interface CopyToastOptions {
  title?: string;
  description?: string;
  duration?: number;
}

const CopyButton = ({ text }: { text: string }) => {
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

export const toastWithCopy = {
  success: (message: string, options?: CopyToastOptions) => {
    toast.success(
      <div className="flex items-center justify-between gap-3 w-full">
        <div className="flex-1 text-black">
          {options?.title && <div className="font-medium text-black">{options.title}</div>}
          <div className="text-black">{message}</div>
          {options?.description && <div className="text-sm text-gray-600">{options.description}</div>}
        </div>
        <CopyButton text={message} />
      </div>,
      {
        duration: options?.duration || 4000,
        style: {
          color: "#000000",
        },
      }
    );
  },
  
  error: (message: string, options?: CopyToastOptions) => {
    toast.error(
      <div className="flex items-center justify-between gap-3 w-full">
        <div className="flex-1 text-black">
          {options?.title && <div className="font-medium text-black">{options.title}</div>}
          <div className="text-black">{message}</div>
          {options?.description && <div className="text-sm text-gray-600">{options.description}</div>}
        </div>
        <CopyButton text={message} />
      </div>,
      {
        duration: options?.duration || 4000,
        style: {
          color: "#000000",
        },
      }
    );
  },
  
  info: (message: string, options?: CopyToastOptions) => {
    toast.info(
      <div className="flex items-center justify-between gap-3 w-full">
        <div className="flex-1 text-black">
          {options?.title && <div className="font-medium text-black">{options.title}</div>}
          <div className="text-black">{message}</div>
          {options?.description && <div className="text-sm text-gray-600">{options.description}</div>}
        </div>
        <CopyButton text={message} />
      </div>,
      {
        duration: options?.duration || 4000,
        style: {
          color: "#000000",
        },
      }
    );
  },
  
  warning: (message: string, options?: CopyToastOptions) => {
    toast.warning(
      <div className="flex items-center justify-between gap-3 w-full">
        <div className="flex-1 text-black">
          {options?.title && <div className="font-medium text-black">{options.title}</div>}
          <div className="text-black">{message}</div>
          {options?.description && <div className="text-sm text-gray-600">{options.description}</div>}
        </div>
        <CopyButton text={message} />
      </div>,
      {
        duration: options?.duration || 4000,
        style: {
          color: "#000000",
        },
      }
    );
  },
  
  // Simple toast with copy button (no additional options)
  copy: (message: string) => {
    toast(
      <div className="flex items-center justify-between gap-3 w-full">
        <div className="flex-1 text-black">{message}</div>
        <CopyButton text={message} />
      </div>,
      {
        duration: 4000,
        style: {
          color: "#000000",
        },
      }
    );
  },
};

// Re-export original toast for backwards compatibility
export { toast };