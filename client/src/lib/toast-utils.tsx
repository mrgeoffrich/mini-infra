import { toast } from "sonner";
import { CopyButton } from "./copy-button";

interface CopyToastOptions {
  title?: string;
  description?: string;
  duration?: number;
}

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
