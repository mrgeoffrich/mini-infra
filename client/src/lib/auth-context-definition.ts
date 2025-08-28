import { createContext } from "react";
import { AuthContextType } from "./auth-types";

export const AuthContext = createContext<AuthContextType | undefined>(undefined);