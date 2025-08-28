import { useContext } from "react";
import { AuthContextType } from "../lib/auth-types";
import { AuthContext } from "../lib/auth-context-definition";

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}