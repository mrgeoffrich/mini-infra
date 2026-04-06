import { useState } from "react";
import { Link } from "react-router-dom";
import { IconBook, IconSearch, IconChevronRight } from "@tabler/icons-react";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { getDocsByCategory, getCategoryLabel } from "@/lib/doc-loader";
import { useDocSearch } from "@/lib/doc-search";

const categories = getDocsByCategory();

export function HelpPage() {
  const [query, setQuery] = useState("");
  const searchResults = useDocSearch(query);
  const isSearching = query.trim().length > 0;

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      <div className="px-4 lg:px-6">
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-md bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300">
            <IconBook className="size-5" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">Documentation</h1>
            <p className="text-muted-foreground text-sm">
              Guides and reference for Mini Infra
            </p>
          </div>
        </div>
      </div>

      <div className="px-4 lg:px-6 max-w-2xl">
        <div className="relative">
          <IconSearch className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input
            placeholder="Search documentation..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-10"
          />
        </div>
      </div>

      <div className="px-4 lg:px-6">
        {isSearching ? (
          <div className="space-y-2 max-w-2xl">
            <p className="text-sm text-muted-foreground mb-4">
              {searchResults.length} result
              {searchResults.length !== 1 ? "s" : ""} for &ldquo;{query}&rdquo;
            </p>
            {searchResults.length === 0 ? (
              <p className="text-muted-foreground py-8 text-center">
                No documentation found matching your search.
              </p>
            ) : (
              searchResults.map((doc) => (
                <Link key={doc.href} to={doc.href}>
                  <div className="rounded-lg border p-4 hover:bg-accent transition-colors cursor-pointer">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-medium text-foreground">
                          {doc.frontmatter.title}
                        </p>
                        <p className="text-sm text-muted-foreground mt-0.5 truncate">
                          {doc.frontmatter.description}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <Badge variant="outline" className="text-xs">
                          {getCategoryLabel(doc.category)}
                        </Badge>
                        <IconChevronRight className="size-4 text-muted-foreground" />
                      </div>
                    </div>
                  </div>
                </Link>
              ))
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {categories.map((category) => (
              <Card key={category.slug} className="py-0 overflow-hidden">
                <CardHeader className="border-b pt-4 pb-4">
                  <CardTitle className="text-base">{category.label}</CardTitle>
                  <CardDescription>
                    {category.docs.length} article
                    {category.docs.length !== 1 ? "s" : ""}
                  </CardDescription>
                </CardHeader>
                <CardContent className="py-3 px-0">
                  {category.docs.map((doc) => (
                    <Link
                      key={doc.slug}
                      to={doc.href}
                      className="flex items-center justify-between px-4 py-2 text-sm hover:bg-accent transition-colors"
                    >
                      <span className="text-foreground">
                        {doc.frontmatter.title}
                      </span>
                      <IconChevronRight className="size-4 text-muted-foreground shrink-0" />
                    </Link>
                  ))}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default HelpPage;
