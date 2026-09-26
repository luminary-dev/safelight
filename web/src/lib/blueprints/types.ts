export type BlueprintCategory = "video" | "audio" | "image" | "3d" | "utility";

/** What a classified input means to the form. Anything unclassified stays baked into the graph. */
export type BlueprintInputKind = "prompt" | "negative-prompt" | "image" | "video" | "audio" | "mask" | "number";

/** Where a user value lands in the flattened API graph. */
export interface PatchTarget {
  nodeId: string;
  input: string;
}

export interface BlueprintInput {
  /** Stable key, the subgraph's exposed input name. */
  key: string;
  /** Human label the blueprint author gave the input. */
  label: string;
  kind: BlueprintInputKind;
  /** Raw ComfyUI socket type, e.g. STRING, INT, IMAGE,MASK. */
  valueType: string;
  /** Baked default pulled from the workflow. Media inputs have none. */
  default?: string | number;
  /** Media inputs must be supplied unless the author marked them optional. */
  required: boolean;
  /** Seed-like numbers are randomized at run time unless the user pins one. */
  seed?: boolean;
  targets: PatchTarget[];
}

export interface Blueprint {
  id: string;
  name: string;
  category: BlueprintCategory;
  inputs: BlueprintInput[];
  /** Every node class the flattened graph executes, including injected load/save nodes. */
  requiredNodeClasses: string[];
  /** Model files baked into loader widgets. */
  requiredModels: string[];
  /** Socket types the workflow produces, in output order. */
  outputTypes: string[];
}

export type BlueprintReadiness = "ready" | "missing" | "unknown";

export interface BlueprintStatus {
  status: BlueprintReadiness;
  missingNodeClasses: string[];
  missingModels: string[];
}

export interface BlueprintListEntry extends Blueprint, BlueprintStatus {}

export interface BlueprintListResponse {
  online: boolean;
  blueprints: BlueprintListEntry[];
  /** Files in the blueprints folder the parser could not handle. */
  failures: { file: string; error: string }[];
}

export interface BlueprintRunRequest {
  /** Values keyed by input key. Media inputs take a ComfyUI input ref like "safelight/photo.png". */
  values?: Record<string, string | number>;
  clientId?: string;
}
