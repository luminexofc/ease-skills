export type SourceId = "github" | "gitlab" | "bitbucket";

export type DiscoveredVia = "reddit" | "x" | "threads";

export type Kind = "skill" | "mcp";

export type CategoryId =
  | "design"
  | "development"
  | "video"
  | "writing"
  | "research"
  | "data"
  | "automation"
  | "productivity";

export type Listing = {
  id: string;
  kind: Kind;
  name: string;
  description: string;
  category: CategoryId;
  source: SourceId;
  url: string;
  owner: string;
  license: string;
  stars: number | null;
  updated: string | null;
  install: string;
  access: string;
  topics: string[];
  via?: DiscoveredVia[];
};

export type ScanNote = {
  source: SourceId | DiscoveredVia;
  status: "ok" | "limited" | "error";
  detail: string;
};

export type ScanResult = {
  items: Listing[];
  notes: ScanNote[];
};

export type LiveSnapshot = {
  items: Listing[];
  notes: ScanNote[];
  at: string;
};

/** A submission the crawler or a person added, before the UI merges it. */
export type SubmitState = "approved" | "pending" | "rejected" | "duplicate";

export type SubmissionResult = {
  ok: boolean;
  state: SubmitState;
  message: string;
  listing?: Listing;
};
