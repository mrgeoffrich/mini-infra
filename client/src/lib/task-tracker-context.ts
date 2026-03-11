import { createContext } from "react";
import type { TaskTrackerContextType } from "./task-tracker-types";

export const TaskTrackerContext = createContext<TaskTrackerContextType | undefined>(undefined);
