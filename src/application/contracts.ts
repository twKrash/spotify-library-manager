import type { CleanupGroupPlan, TrackSummary } from "../domain/types.js";

export interface CleanupPreview {
  preview_id: string;
  groups: Array<{ group_id: string; plan: CleanupGroupPlan }>;
  removal_count: number;
  confirmation_text: string;
}

export interface RestorePreview {
  preview_id: string;
  operation_id: string;
  tracks: TrackSummary[];
  restore_count: number;
  confirmation_text: string;
}

export interface OperationSummary {
  id: string;
  operation: "duplicate_cleanup" | "manual_removal";
  created_at: string;
  track_count: number;
  deleted_track_count: number;
  restored_track_count: number;
  status: string;
  restore_status: string;
}

export interface MutationResult {
  operation_id: string;
  track_count: number;
}
