import { useParams, Link, Navigate } from "react-router-dom";
import { IconBook, IconChevronRight } from "@tabler/icons-react";
import { getDocBySlug } from "@/lib/doc-loader";
import { DocContent } from "@/components/help/DocContent";
import { DocToc } from "@/components/help/DocToc";
import { DocNavigation } from "@/components/help/DocNavigation";
import { HelpDocSidebar } from "@/components/help/HelpDocSidebar";
import { Badge } from "@/components/ui/badge";

export function HelpDocPage() {
  const { category, slug } = useParams<{ category: string; slug: string }>();
  const doc = getDocBySlug(category!, slug!);

  if (!doc) {
    return <Navigate to="/help" replace />;
  }

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      <div className="px-4 lg:px-6">
        <div className="flex items-center gap-2 text-sm text-muted-foreground mb-2">
          <Link
            to="/help"
            className="hover:text-foreground transition-colors flex items-center gap-1"
          >
            <IconBook className="size-3.5" />
            Documentation
          </Link>
          <IconChevronRight className="size-3.5" />
          <span className="text-foreground">{doc.frontmatter.title}</span>
        </div>
      </div>

      <div className="px-4 lg:px-6">
        <div className="flex gap-8 items-start">
          {/* Left: doc tree navigation */}
          <aside className="hidden lg:block w-52 shrink-0 sticky top-20">
            <HelpDocSidebar />
          </aside>

          {/* Center: doc content */}
          <main className="min-w-0 flex-1 max-w-3xl">
            <div className="mb-6">
              {doc.frontmatter.tags && doc.frontmatter.tags.length > 0 && (
                <div className="flex items-center gap-2 mb-2">
                  {doc.frontmatter.tags.map((tag) => (
                    <Badge key={tag} variant="secondary" className="text-xs">
                      {tag}
                    </Badge>
                  ))}
                </div>
              )}
              <p className="text-muted-foreground text-lg">
                {doc.frontmatter.description}
              </p>
            </div>

            <DocContent content={doc.content} />
            <DocNavigation current={doc} />
          </main>

          {/* Right: TOC */}
          <aside className="hidden xl:block w-48 shrink-0 sticky top-20">
            <DocToc content={doc.content} />
          </aside>
        </div>
      </div>
    </div>
  );
}

export default HelpDocPage;
