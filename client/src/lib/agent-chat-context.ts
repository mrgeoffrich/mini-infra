import { createContext } from "react";
import { AgentChatContextType } from "./agent-chat-types";

export const AgentChatContext = createContext<AgentChatContextType | undefined>(
  undefined,
);
