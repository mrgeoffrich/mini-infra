declare module "passport-google-oidc" {
  import { Strategy } from "passport-strategy";

  export interface Profile {
    id: string;
    displayName?: string;
    emails?: Array<{
      value: string;
      verified?: boolean;
    }>;
    photos?: Array<{
      value: string;
    }>;
    provider: string;
  }

  export interface StrategyOptions {
    clientID: string;
    clientSecret: string;
    callbackURL: string;
    scope?: string[];
  }

  export type VerifyCallback = (
    issuer: string,
    profile: Profile,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    done: (error: any, user?: any, info?: any) => void,
  ) => void | Promise<void>;

  export class Strategy extends Strategy {
    constructor(options: StrategyOptions, verify: VerifyCallback);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    authenticate(req: any, options?: any): void;
  }
}
