import type { JWTUser, PermissionScope } from "@mini-infra/types";

declare module "express-serve-static-core" {
  interface Request {
    user?: JWTUser & { mustResetPwd?: boolean };
    apiKey?: {
      id: string;
      userId: string;
      user: JWTUser;
      permissions: PermissionScope[] | null;
    };
    logout(done: (err: unknown) => void): void;
  }
}
