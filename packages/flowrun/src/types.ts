export type LocatorFields = {
  role?: string;
  name?: string;
  testid?: string;
  text?: string;
  css?: string;
  placeholder?: string;
};

export type WorkflowStep =
  | { navigate: { url: string } }
  | { click: LocatorFields }
  | {
      fill: LocatorFields & {
        value?: string;
        value_from?: string;
      };
    }
  | { press: { key: string } }
  | {
      wait: {
        url_includes?: string;
        text?: string;
        timeout_ms?: number;
      };
    }
  | {
      assert: {
        url_includes?: string;
        text?: string;
        title_includes?: string;
      };
    }
  | {
      screenshot: {
        path?: string;
        full_page?: boolean;
      };
    };

export type ParamSpec = {
  type: "string" | "number" | "boolean";
  required?: boolean;
  default?: unknown;
  description?: string;
};

export type WorkflowMeta = {
  verified?: {
    verified_at: string;
    runs: number;
    all_passed: boolean;
    avg_duration_ms: number;
    params_used: Record<string, string>;
    environment: string;
  };
  promoted?: {
    promoted_at: string;
    promoted_from: string;
  };
};

export type Workflow = {
  id: string;
  version: string;
  title?: string;
  description?: string;
  site_id: string;
  origins: string[];
  tags?: string[];
  aliases?: string[];
  params?: Record<string, ParamSpec>;
  requires_vault?: string[];
  steps: WorkflowStep[];
  pitfalls?: string[];
  meta?: WorkflowMeta;
};

export type WorkflowRecord = {
  workflow: Workflow;
  path: string;
  layer: "local" | "seed";
};

export type StepResult = {
  index: number;
  step: string;
  ok: boolean;
  error?: string;
  duration_ms: number;
  screenshot?: string;
};

export type RunResult = {
  ok: boolean;
  ref: string;
  version: string;
  layer: "local" | "seed";
  started_at: string;
  finished_at: string;
  duration_ms: number;
  final_url?: string;
  steps: StepResult[];
  error?: string;
  screenshot?: string;
  missing_vault?: string[];
  missing_params?: string[];
};

export type VerifyRunDetail = {
  index: number;
  ok: boolean;
  duration_ms: number;
  error?: string;
  screenshot_sha256?: string;
};

export type VerifyResult = {
  ok: boolean;
  ref: string;
  version: string;
  runs: number;
  passed: number;
  failed: number;
  all_ok: boolean;
  flaky: boolean;
  avg_duration_ms: number;
  runs_detail: VerifyRunDetail[];
  screenshot_deltas?: Array<{
    run_a: number;
    run_b: number;
    changed_pixels_pct: number;
    delta_png_bytes: number;
  }>;
  params_used: Record<string, string>;
};

export type PromoteOptions = {
  ref: string;
  version?: string;
  force?: boolean;
  root: string;
};
