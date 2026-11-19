export interface FeedEntry {
  id: string;
  title: string;
  link: string | null;
  description: string;
  publishedAt: string | null;
  feedTitle?: string;
}

export interface ParsedFeed {
  title: string;
  entries: FeedEntry[];
}

export interface FeedRoute {
  url: string;
  destinations: string[];
}

export interface Delivery {
  feedUrl: string;
  destination: string;
  entry: FeedEntry;
  attempts: number;
}

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
