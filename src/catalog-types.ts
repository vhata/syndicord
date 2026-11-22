/** Public catalog protocol. Saved feed URLs and webhook credentials never appear here. */
export interface ChannelScope {
  guildId: string;
  channelId: string;
}

export interface CatalogPermissions {
  addFeeds: boolean;
  channels: ChannelScope[];
}

export interface CatalogSnapshot {
  mode: 'scoped';
  initialized: boolean;
  revision: string;
  permissions: CatalogPermissions;
  feeds: { id: string; label: string }[];
  destinations: ({ id: string; label: string } & ChannelScope)[];
  subscriptions: { feedId: string; destinationId: string }[];
  maxBytes: number;
}

export type CatalogOperation =
  | { type: 'initialize' }
  | { type: 'feed.create'; label: string; url: string }
  | { type: 'feed.rename'; id: string; label: string }
  | { type: 'feed.delete'; id: string }
  | { type: 'destination.create'; label: string; webhookUrl: string }
  | { type: 'destination.rename'; id: string; label: string }
  | { type: 'destination.rotate'; id: string; webhookUrl: string }
  | { type: 'destination.delete'; id: string }
  | {
      type: 'subscription.add' | 'subscription.remove';
      feedId: string;
      destinationId: string;
    };

export interface CatalogMutation {
  revision: string;
  operation: CatalogOperation;
}
