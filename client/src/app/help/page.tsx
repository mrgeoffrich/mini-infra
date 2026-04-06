import { Link } from "react-router-dom";
import { IconBook, IconChevronRight } from "@tabler/icons-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { getDocsByCategory } from "@/lib/doc-loader";

const categories = getDocsByCategory();

export function HelpPage() {
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

      <div className="px-4 lg:px-6">
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
      </div>
    </div>
  );
}

export default HelpPage;
