import type { JWTUser, PermissionScope } from "@mini-infra/types";

declare module "express-serve-static-core" {
  interface Request {
    user?: JWTUser & { mustResetPwd?: boolean };
    apiKey?: {
      id: string;
      userId: string | null;
      user: JWTUser | null;
      permissions: PermissionScope[] | null;
    };
    logout(done: (err: unknown) => void): void;
  }
}
