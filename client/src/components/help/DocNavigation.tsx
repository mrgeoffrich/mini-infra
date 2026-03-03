import { Link } from "react-router-dom";
import { IconArrowLeft, IconArrowRight } from "@tabler/icons-react";
import { docRegistry, type DocEntry } from "@/lib/doc-loader";
import { Separator } from "@/components/ui/separator";

interface DocNavigationProps {
  current: DocEntry;
}

export function DocNavigation({ current }: DocNavigationProps) {
  const idx = docRegistry.findIndex(
    (d) => d.category === current.category && d.slug === current.slug
  );
  const prev = idx > 0 ? docRegistry[idx - 1] : null;
  const next = idx < docRegistry.length - 1 ? docRegistry[idx + 1] : null;

  if (!prev && !next) return null;

  return (
    <div className="mt-12">
      <Separator className="mb-8" />
      <div className="flex items-center justify-between gap-4">
        {prev ? (
          <Link
            to={prev.href}
            className="group flex items-center gap-2 rounded-lg border p-4 text-sm hover:bg-accent transition-colors flex-1 max-w-[48%]"
          >
            <IconArrowLeft className="size-4 shrink-0 text-muted-foreground group-hover:text-foreground transition-colors" />
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground mb-0.5">Previous</p>
              <p className="font-medium text-foreground truncate">
                {prev.frontmatter.title}
              </p>
            </div>
          </Link>
        ) : (
          <div className="flex-1" />
        )}
        {next ? (
          <Link
            to={next.href}
            className="group flex items-center justify-end gap-2 rounded-lg border p-4 text-sm hover:bg-accent transition-colors flex-1 max-w-[48%] text-right"
          >
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground mb-0.5">Next</p>
              <p className="font-medium text-foreground truncate">
                {next.frontmatter.title}
              </p>
            </div>
            <IconArrowRight className="size-4 shrink-0 text-muted-foreground group-hover:text-foreground transition-colors" />
          </Link>
        ) : (
          <div className="flex-1" />
        )}
      </div>
    </div>
  );
}
