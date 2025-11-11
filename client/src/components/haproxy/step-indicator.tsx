import { type Icon, IconCheck } from "@tabler/icons-react";
import { cn } from "@/lib/utils";

export interface Step {
  number: number;
  title: string;
  icon: Icon;
}

interface StepIndicatorProps {
  steps: Step[];
  currentStep: number;
  className?: string;
}

/**
 * Multi-step wizard progress indicator
 *
 * Displays horizontal stepper with:
 * - Completed steps (green check icon)
 * - Current step (blue icon)
 * - Future steps (gray icon)
 * - Lines connecting steps
 */
export function StepIndicator({
  steps,
  currentStep,
  className,
}: StepIndicatorProps) {
  return (
    <div className={cn("w-full", className)}>
      <div className="flex items-center justify-between">
        {steps.map((step, index) => {
          const isCompleted = step.number < currentStep;
          const isCurrent = step.number === currentStep;
          const isFuture = step.number > currentStep;
          const StepIcon = step.icon;
          const isLast = index === steps.length - 1;

          return (
            <div key={step.number} className="flex items-center flex-1">
              <div className="flex flex-col items-center flex-shrink-0">
                {/* Step Icon/Number */}
                <div
                  className={cn(
                    "flex items-center justify-center w-10 h-10 rounded-full border-2 transition-colors",
                    isCompleted &&
                      "bg-green-100 border-green-600 dark:bg-green-950 dark:border-green-500",
                    isCurrent &&
                      "bg-blue-100 border-blue-600 dark:bg-blue-950 dark:border-blue-500",
                    isFuture &&
                      "bg-muted border-muted-foreground/20 dark:border-muted-foreground/20",
                  )}
                >
                  {isCompleted ? (
                    <IconCheck className="w-5 h-5 text-green-700 dark:text-green-400" />
                  ) : (
                    <StepIcon
                      className={cn(
                        "w-5 h-5",
                        isCurrent && "text-blue-700 dark:text-blue-400",
                        isFuture && "text-muted-foreground/50",
                      )}
                    />
                  )}
                </div>

                {/* Step Title */}
                <div
                  className={cn(
                    "mt-2 text-xs font-medium text-center whitespace-nowrap",
                    (isCompleted || isCurrent) && "text-foreground",
                    isFuture && "text-muted-foreground",
                  )}
                >
                  {step.title}
                </div>
              </div>

              {/* Connecting Line */}
              {!isLast && (
                <div
                  className={cn(
                    "flex-1 h-0.5 mx-2 transition-colors",
                    isCompleted &&
                      "bg-green-600 dark:bg-green-500",
                    !isCompleted && "bg-muted-foreground/20",
                  )}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
