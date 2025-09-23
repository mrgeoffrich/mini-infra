import React, { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  FormControl,
  FormDescription,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  AlertCircle,
  CheckCircle,
  Loader2,
  ExternalLink,
  Lightbulb,
  Globe,
  AlertTriangle,
} from "lucide-react";
import { useHostnameValidationWithDebounce, useHostnameSuggestions } from "@/hooks/use-hostname-validation";
import { cn } from "@/lib/utils";

interface HostnameInputProps {
  value: string;
  onChange: (value: string) => void;
  excludeConfigId?: string;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  description?: string;
  showValidation?: boolean;
  debounceMs?: number;
}

export function HostnameInput({
  value,
  onChange,
  excludeConfigId,
  disabled = false,
  placeholder = "api.example.com",
  className,
  description,
  showValidation = true,
  debounceMs = 500,
}: HostnameInputProps) {
  const [showSuggestions, setShowSuggestions] = useState(false);

  const validation = useHostnameValidationWithDebounce(
    value,
    excludeConfigId,
    debounceMs,
    showValidation && !!value
  );

  const { suggestions, hasSuggestions } = useHostnameSuggestions(value, validation.validationResult);

  // Auto-hide suggestions when hostname becomes valid and available
  useEffect(() => {
    if (validation.isValid && validation.isAvailable) {
      setShowSuggestions(false);
    }
  }, [validation.isValid, validation.isAvailable]);

  const getValidationState = () => {
    if (!value || !showValidation) return "neutral";
    if (validation.isValidating || validation.isDebouncing) return "validating";
    if (!validation.validationResult) return "neutral";
    if (!validation.isValid) return "invalid";
    if (validation.isValid && validation.isAvailable) return "valid";
    if (validation.isValid && !validation.isAvailable) return "conflict";
    return "neutral";
  };

  const validationState = getValidationState();

  const getValidationIcon = () => {
    switch (validationState) {
      case "validating":
        return <Loader2 className="h-4 w-4 animate-spin text-blue-500" />;
      case "valid":
        return <CheckCircle className="h-4 w-4 text-green-500" />;
      case "invalid":
        return <AlertCircle className="h-4 w-4 text-red-500" />;
      case "conflict":
        return <AlertTriangle className="h-4 w-4 text-yellow-500" />;
      default:
        return <Globe className="h-4 w-4 text-gray-400" />;
    }
  };

  const getValidationMessage = () => {
    if (!validation.validationResult && !validation.validationError) return null;

    if (validation.validationError) {
      return (
        <Alert variant="destructive" className="mt-2">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            Failed to validate hostname: {validation.validationError.message}
          </AlertDescription>
        </Alert>
      );
    }

    if (validation.validationResult) {
      const { isValid, isAvailable, message, conflictDetails } = validation.validationResult;

      if (!isValid) {
        return (
          <Alert variant="destructive" className="mt-2">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{message}</AlertDescription>
          </Alert>
        );
      }

      if (isValid && isAvailable) {
        return (
          <Alert className="mt-2 border-green-200 bg-green-50">
            <CheckCircle className="h-4 w-4 text-green-600" />
            <AlertDescription className="text-green-700">{message}</AlertDescription>
          </Alert>
        );
      }

      if (isValid && !isAvailable) {
        return (
          <Alert variant="destructive" className="mt-2">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              <div className="space-y-2">
                <p>{message}</p>
                {conflictDetails && (
                  <div className="space-y-1">
                    {conflictDetails.existsInDeploymentConfigs && conflictDetails.conflictingConfigName && (
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="text-xs">
                          Deployment Config
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          Used by: {conflictDetails.conflictingConfigName}
                        </span>
                      </div>
                    )}
                    {conflictDetails.existsInCloudflare && conflictDetails.cloudflareZone && (
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="text-xs">
                          Cloudflare
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          Zone: {conflictDetails.cloudflareZone}
                        </span>
                      </div>
                    )}
                  </div>
                )}
                {hasSuggestions && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setShowSuggestions(!showSuggestions)}
                    className="mt-2"
                  >
                    <Lightbulb className="h-3 w-3 mr-1" />
                    {showSuggestions ? "Hide" : "Show"} Suggestions
                  </Button>
                )}
              </div>
            </AlertDescription>
          </Alert>
        );
      }
    }

    return null;
  };

  return (
    <div className="space-y-2">
      <FormItem>
        <FormLabel className="flex items-center gap-2">
          Hostname (Optional)
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <ExternalLink className="h-3 w-3 text-muted-foreground cursor-help" />
              </TooltipTrigger>
              <TooltipContent>
                <p className="max-w-xs">
                  Public hostname for accessing your application through Cloudflare tunnel.
                  Must be a valid domain name (e.g., api.example.com).
                </p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </FormLabel>

        <div className="relative">
          <FormControl>
            <Input
              placeholder={placeholder}
              value={value}
              onChange={(e) => onChange(e.target.value)}
              disabled={disabled}
              className={cn(
                "pr-10",
                validationState === "valid" && "border-green-500 focus-visible:ring-green-500",
                validationState === "invalid" && "border-red-500 focus-visible:ring-red-500",
                validationState === "conflict" && "border-yellow-500 focus-visible:ring-yellow-500",
                className
              )}
            />
          </FormControl>

          <div className="absolute inset-y-0 right-0 flex items-center pr-3">
            {getValidationIcon()}
          </div>
        </div>

        {description && (
          <FormDescription>
            {description}
          </FormDescription>
        )}

        <FormMessage />
      </FormItem>

      {/* Validation Message */}
      {showValidation && getValidationMessage()}

      {/* Hostname Suggestions */}
      {showValidation && showSuggestions && hasSuggestions && (
        <Alert className="mt-2">
          <Lightbulb className="h-4 w-4" />
          <AlertDescription>
            <div className="space-y-2">
              <p className="font-medium">Try these alternatives:</p>
              <div className="flex flex-wrap gap-2">
                {suggestions.slice(0, 6).map((suggestion) => (
                  <Button
                    key={suggestion}
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      onChange(suggestion);
                      setShowSuggestions(false);
                    }}
                    className="h-7 text-xs"
                  >
                    {suggestion}
                  </Button>
                ))}
              </div>
              {suggestions.length > 6 && (
                <p className="text-xs text-muted-foreground">
                  +{suggestions.length - 6} more suggestions available
                </p>
              )}
            </div>
          </AlertDescription>
        </Alert>
      )}

      {/* Debug info in development */}
      {process.env.NODE_ENV === "development" && validation.validationResult && (
        <details className="mt-2">
          <summary className="text-xs text-muted-foreground cursor-pointer">
            Debug: Validation Details
          </summary>
          <pre className="text-xs mt-1 p-2 bg-gray-50 rounded border overflow-auto">
            {JSON.stringify(validation.validationResult, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}

// Higher-order component for form integration
export function HostnameFormField({
  field,
  excludeConfigId,
  ...props
}: {
  field: {
    value: string;
    onChange: (value: string) => void;
  };
  excludeConfigId?: string;
} & Omit<HostnameInputProps, 'value' | 'onChange'>) {
  return (
    <HostnameInput
      value={field.value || ""}
      onChange={field.onChange}
      excludeConfigId={excludeConfigId}
      {...props}
    />
  );
}