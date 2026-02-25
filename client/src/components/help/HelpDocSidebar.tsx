import { Link, useLocation } from "react-router-dom";
import { getDocsByCategory } from "@/lib/doc-loader";
import { cn } from "@/lib/utils";

const categories = getDocsByCategory();

export function HelpDocSidebar() {
  const location = useLocation();

  return (
    <nav className="space-y-6">
      {categories.map((category) => (
        <div key={category.slug}>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
            {category.label}
          </p>
          <div className="space-y-0.5">
            {category.docs.map((doc) => (
              <Link
                key={doc.slug}
                to={doc.href}
                className={cn(
                  "block rounded-md px-3 py-1.5 text-sm transition-colors",
                  location.pathname === doc.href
                    ? "bg-accent text-accent-foreground font-medium"
                    : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
                )}
              >
                {doc.frontmatter.title}
              </Link>
            ))}
          </div>
        </div>
      ))}
    </nav>
  );
}
