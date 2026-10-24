export interface SpotifyTrack {
  id?: string | null;
  name?: string | null;
  artists?: Array<{ name?: string | null }> | null;
  album?: { name?: string | null } | null;
  duration_ms?: number | null;
  external_ids?: { isrc?: string | null } | null;
  external_urls?: { spotify?: string | null } | null;
  added_at?: string | null;
}

export interface SongRecord {
  title: string;
  artists: string[];
  album: string;
  spotify_id: string | null;
  duration_ms: number;
  isrc: string | null;
  song_id: string;
  url: string | null;
  added_at: string | null;
}

export interface DuplicateGroup {
  song_ids: string[];
  isrcs: string[];
  title: string;
  artists: string[];
  album: string;
  copies: number;
  extra_copies: number;
}

export interface RankingArtist {
  rank: number;
  name: string | null;
  url: string | null;
  genres: string[];
}

export interface RankingTrack extends SongRecord {
  rank: number;
}

export interface TopRanking {
  label: string;
  artists: RankingArtist[];
  tracks: RankingTrack[];
}

export interface RecentPlay extends SongRecord {
  played_at: string | null;
}

export interface RecentTrackSummary {
  song_id: string;
  title: string;
  artists: string[];
  album: string;
  plays: number;
}

export interface RecentArtistSummary {
  name: string;
  plays: number;
}

export interface ApiStatistics {
  top_rankings: Record<string, TopRanking>;
  recent_play_count: number;
  recent_play_limit: number;
  recently_played: RecentPlay[];
  most_played_recent_tracks: RecentTrackSummary[];
  most_played_recent_artists: RecentArtistSummary[];
}

export interface SavedLibraryStatistics {
  track_count: number;
  unique_track_count: number;
  duplicate_group_count: number;
  artist_count: number;
  artist_album_count: number;
  top_artists: Array<{ name: string; track_count: number }>;
  top_albums: Array<{ artist: string; name: string; track_count: number }>;
  collection_runtime_ms: number;
}

export interface LibraryAlbum {
  name: string;
  songs: SongRecord[];
}

export interface LibraryArtist {
  name: string;
  albums: LibraryAlbum[];
}

export interface LibraryReport {
  generated_at: string;
  liked_track_count: number;
  unique_song_count: number;
  duplicate_song_count: number;
  extra_duplicate_count: number;
  duplicates: DuplicateGroup[];
  artists: LibraryArtist[];
  statistics: ApiStatistics & { saved_library: SavedLibraryStatistics };
}

export interface ToonExport {
  generated_at: string;
  liked_track_count: number;
  unique_song_count: number;
  duplicate_song_count: number;
  extra_duplicate_count: number;
  statistics: LibraryReport["statistics"];
  tracks: SongRecord[];
  duplicates: DuplicateGroup[];
}

export interface TrackSummary {
  id: string;
  added_at: string;
  title: string;
  artists: string[];
  album: string;
}

export interface CleanupDuplicateGroup extends Pick<DuplicateGroup, "song_ids" | "title" | "artists" | "copies" | "extra_copies"> {
  [key: string]: unknown;
}

export interface CleanupGroupPlan {
  group: CleanupDuplicateGroup;
  keep: TrackSummary;
  remove: TrackSummary[];
}

export interface CleanupBandPlan {
  artist: string;
  extra_copies: number;
  groups: CleanupGroupPlan[];
}

export type CleanupPlan = CleanupBandPlan[];

export type RestoreStatus = "not_started" | "in_progress" | "completed";
export type ManifestProgressField = "deleted_track_ids" | "restored_track_ids";

export interface CleanupManifestV1 {
  schema_version: 1;
  created_at: string;
  cleanup_status: "in_progress" | "completed";
  restore_status: RestoreStatus;
  groups: Array<{ keep: TrackSummary; remove: TrackSummary[] }>;
  deleted_track_ids: string[];
  restored_track_ids: string[];
}

export interface ManualRemovalManifestV2 {
  schema_version: 2;
  operation: "manual_removal";
  created_at: string;
  status: "in_progress" | "completed";
  restore_status: RestoreStatus;
  tracks: TrackSummary[];
  deleted_track_ids: string[];
  restored_track_ids: string[];
}

export type OperationManifest = CleanupManifestV1 | ManualRemovalManifestV2;
