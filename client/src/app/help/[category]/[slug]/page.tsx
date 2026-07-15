import { useEffect, useState } from "react";
import { useParams, Navigate } from "react-router-dom";
import { getDocBySlug, loadDocContent } from "@/lib/doc-loader";
import { DocContent } from "@/components/help/DocContent";
import { DocToc } from "@/components/help/DocToc";
import { DocNavigation } from "@/components/help/DocNavigation";
import { AuthSpinner } from "@/components/auth-spinner";
import { Badge } from "@/components/ui/badge";

export function HelpDocPage() {
  const { category, slug } = useParams<{ category: string; slug: string }>();
  const doc = getDocBySlug(category!, slug!);
  const key = `${category}/${slug}`;

  // The article body is loaded lazily (doc bodies are no longer in the initial
  // bundle — see doc-loader.ts). Loaded content is stored with the key it
  // belongs to; when the route changes, `loaded` derives to null (loading)
  // without a synchronous state reset inside the effect.
  const [state, setState] = useState<{ key: string; content: string | null } | null>(null);

  useEffect(() => {
    if (!category || !slug) return;
    let active = true;
    void loadDocContent(category, slug).then((body) => {
      if (active) setState({ key, content: body });
    });
    return () => {
      active = false;
    };
  }, [key, category, slug]);

  if (!doc) {
    return <Navigate to="/help" replace />;
  }

  const content = state && state.key === key ? state.content : undefined;

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      <div className="px-4 lg:px-6">
        <div className="flex gap-8 items-start">
          {/* Main: doc content */}
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

            {content === undefined ? (
              <div className="py-16">
                <AuthSpinner showCard={false} />
              </div>
            ) : (
              <>
                <DocContent content={content ?? ""} />
                <DocNavigation current={doc} />
              </>
            )}
          </main>

          {/* Right: TOC */}
          <aside className="hidden xl:block w-48 shrink-0 sticky top-20">
            {content ? <DocToc content={content} /> : null}
          </aside>
        </div>
      </div>
    </div>
  );
}

export default HelpDocPage;
