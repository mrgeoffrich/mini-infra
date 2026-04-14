export interface AcmeProblem {
  type?: string;
  detail?: string;
  status?: number;
  subproblems?: AcmeProblem[];
  [key: string]: unknown;
}

export class AcmeProblemError extends Error {
  readonly type: string | undefined;
  readonly detail: string | undefined;
  readonly status: number | undefined;
  readonly subproblems: AcmeProblem[] | undefined;
  readonly problem: AcmeProblem;

  constructor(problem: AcmeProblem, fallbackMessage = "ACME request failed") {
    const msg = problem.detail || problem.type || fallbackMessage;
    super(msg);
    this.name = "AcmeProblemError";
    this.type = problem.type;
    this.detail = problem.detail;
    this.status = problem.status;
    this.subproblems = problem.subproblems;
    this.problem = problem;
  }

  isBadNonce(): boolean {
    return this.type === "urn:ietf:params:acme:error:badNonce";
  }
}
