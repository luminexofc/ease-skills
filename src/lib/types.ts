export type SourceId = "github" | "gitlab" | "bitbucket";

export type DiscoveredVia = "reddit" | "x";

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
