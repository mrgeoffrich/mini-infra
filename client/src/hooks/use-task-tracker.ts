import { useContext } from "react";
import { TaskTrackerContext } from "@/lib/task-tracker-context";
import type { TaskTrackerContextType } from "@/lib/task-tracker-types";

export function useTaskTracker(): TaskTrackerContextType {
  const context = useContext(TaskTrackerContext);
  if (context === undefined) {
    throw new Error("useTaskTracker must be used within TaskTrackerProvider");
  }
  return context;
}
