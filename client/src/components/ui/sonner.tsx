import { Toaster as Sonner, ToasterProps } from "sonner";

const Toaster = ({ ...props }: ToasterProps) => {
  // Use system theme detection instead of next-themes
  const theme =
    window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "#000000", // Force black text
          "--normal-border": "var(--border)",
        } as React.CSSProperties
      }
      toastOptions={{
        style: {
          color: "#000000", // Force black text for all toasts
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
