import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Copy, Check } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface IconDefinition {
  name: string;
  component: React.ComponentType<React.SVGProps<SVGSVGElement>>;
  library: "lucide";
  usage: string;
  importPath: string;
  sizes?: string[];
}

interface IconCardProps {
  icon: IconDefinition;
  onCopy: (text: string, iconName: string) => void;
  isCopied: boolean;
}

export function IconCard({ icon, onCopy, isCopied }: IconCardProps) {
  const IconComponent = icon.component;

  return (
    <Card className="p-4 hover:shadow-md transition-shadow">
      <div className="flex flex-col gap-3">
        {/* Icon Display */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-3 rounded-lg bg-primary/10 flex items-center justify-center">
              <IconComponent
                className="h-6 w-6"
              />
            </div>
            <div className="flex-1">
              <div className="font-mono text-sm font-semibold">
                {icon.name}
              </div>
              <Badge
                variant="outline"
                className="mt-1 text-xs"
              >
                Lucide
              </Badge>
            </div>
          </div>
        </div>

        {/* Usage Description */}
        <p className="text-xs text-muted-foreground line-clamp-2">
          {icon.usage}
        </p>

        {/* Size Variants */}
        {icon.sizes && icon.sizes.length > 0 && (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-muted-foreground">Sizes:</span>
            {icon.sizes.map((size, index) => (
              <TooltipProvider key={index}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="p-2 rounded bg-muted/50 flex items-center justify-center">
                      <IconComponent
                        className={size}
                      />
                    </div>
                  </TooltipTrigger>
                  <TooltipContent>
                    <code className="text-xs">{size}</code>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ))}
          </div>
        )}

        {/* Import Statement */}
        <div className="flex items-center gap-2">
          <code className="flex-1 text-xs bg-muted px-2 py-1 rounded font-mono overflow-x-auto whitespace-nowrap">
            {icon.importPath}
          </code>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0"
            onClick={() => onCopy(icon.importPath, icon.name)}
          >
            {isCopied ? (
              <Check className="h-3 w-3 text-green-600" />
            ) : (
              <Copy className="h-3 w-3" />
            )}
          </Button>
        </div>

        {/* Usage Example */}
        <div className="mt-2 pt-2 border-t">
          <code className="text-xs text-muted-foreground font-mono block">
            {`<${icon.name} className="${icon.sizes?.[0] || "h-6 w-6"}" />`}
          </code>
        </div>
      </div>
    </Card>
  );
}
