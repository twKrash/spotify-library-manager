import type { DuplicateGroup, LibraryReport, TrackSummary } from "../domain/types.js";
import type { CleanupPreview, OperationSummary, RestorePreview } from "../application/contracts.js";

interface LibraryResponse {
  library: LibraryReport | null;
  stale: boolean;
  connected: boolean;
}

export function isLibraryReport(value: unknown): value is LibraryReport {
  if (!isRecord(value) || !isRecord(value.statistics) || !isRecord(value.statistics.saved_library)) return false;
  const saved = value.statistics.saved_library;
  return typeof value.generated_at === "string" &&
    typeof value.liked_track_count === "number" &&
    typeof value.unique_song_count === "number" &&
    typeof value.duplicate_song_count === "number" &&
    typeof value.extra_duplicate_count === "number" &&
    typeof saved.track_count === "number" &&
    typeof saved.unique_track_count === "number" &&
    typeof saved.artist_count === "number" &&
    typeof saved.artist_album_count === "number" &&
    typeof saved.collection_runtime_ms === "number" &&
    Array.isArray(saved.top_artists) && Array.isArray(saved.top_albums) &&
    Array.isArray(value.artists) && Array.isArray(value.duplicates);
}

export function manualRemovalConfirmation(title: string, artists: string[]): string {
  return `REMOVE ${title} — ${artists.join(", ")}`;
}

export async function syncAndRefresh(sync: () => Promise<unknown>, refresh: () => Promise<void>, onComplete?: () => void): Promise<void> {
  await sync();
  await refresh();
  onComplete?.();
}

export function safeSpotifyUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "open.spotify.com" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function startDashboard(document: Document, fetcher: typeof fetch = globalThis.fetch): void {
  const offline = document.body.dataset.offline === "true";
  const embeddedText = document.getElementById("library-data")?.textContent?.trim() ?? "";
  let current: LibraryResponse = { library: null, stale: false, connected: false };
  let cleanupPreview: CleanupPreview | null = null;
  let approvedCleanup: CleanupPreview | null = null;
  let restorePreview: RestorePreview | null = null;

  const status = get<HTMLElement>(document, "app-status");
  const connect = get<HTMLAnchorElement>(document, "connect-link");
  const syncButton = get<HTMLButtonElement>(document, "sync-button");
  const reviewButton = get<HTMLButtonElement>(document, "review-duplicates");
  const cleanupCandidates = get<HTMLElement>(document, "cleanup-candidates");
  const cleanupApplyBar = get<HTMLElement>(document, "cleanup-apply-bar");
  const cleanupPreviewPanel = get<HTMLElement>(document, "cleanup-preview");
  const cleanupApplyButton = get<HTMLButtonElement>(document, "cleanup-apply");
  const operationsSelect = get<HTMLSelectElement>(document, "restore-operation");
  const restorePreviewButton = get<HTMLButtonElement>(document, "restore-preview-button");
  const restorePreviewPanel = get<HTMLElement>(document, "restore-preview-panel");
  const restoreApplyButton = get<HTMLButtonElement>(document, "restore-apply-button");
  const appControls = get<HTMLElement>(document, "app-controls");

  if (offline) {
    appControls.hidden = true;
    const report = parseEmbeddedReport(embeddedText);
    if (report) renderReport(document, report, () => undefined, () => undefined, false);
    else showLoadError(document, "Offline library data could not be loaded.");
    return;
  }

  const setStatus = (message: string, error = false): void => {
    status.textContent = message;
    status.classList.toggle("load-error", error);
  };

  const request = async <T>(url: string, body?: unknown): Promise<T> => {
    const response = await fetcher(url, body === undefined ? { credentials: "same-origin" } : {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    let payload: unknown;
    try { payload = await response.json(); }
    catch { throw new Error("The app returned an invalid response."); }
    if (!response.ok) {
      const message = isRecord(payload) && typeof payload.error === "string" ? payload.error : "The request failed.";
      throw new Error(message);
    }
    return payload as T;
  };

  const setSnapshotState = (): void => {
    connect.hidden = current.connected;
    syncButton.disabled = !current.connected;
    reviewButton.disabled = !current.library || current.stale || current.library.duplicates.length === 0;
    get<HTMLButtonElement>(document, "cleanup-preview-button").disabled = current.stale || !current.library?.duplicates.length;
    for (const button of document.querySelectorAll<HTMLButtonElement>(".manual-remove, .duplicate-remove, #cleanup-apply, #restore-preview-button, #restore-apply-button")) {
      button.disabled = current.stale || !current.connected;
      button.title = current.stale ? "Sync before making another change." : "";
    }
    if (current.stale) setStatus("Spotify changed. Sync again before making more changes.");
    else if (!current.connected) setStatus("Connect Spotify to sync or change your library.");
    else if (!current.library) setStatus("Connected. Sync to load your library.");
    else setStatus(`Snapshot ready · ${new Date(current.library.generated_at).toLocaleString()}`);
  };

  const refresh = async (): Promise<void> => {
    current = await request<LibraryResponse>("/api/library");
    setSnapshotState();
    if (current.library) renderReport(document, current.library, removeTrack, previewDuplicateGroup, true, current.stale || !current.connected);
    else showLoadError(document, "No library snapshot yet. Connect Spotify, then sync.");
    await refreshOperations();
  };

  const refreshOperations = async (): Promise<void> => {
    const entries = await request<OperationSummary[]>("/api/operations");
    operationsSelect.replaceChildren(option(document, "", "Choose a saved operation…"));
    for (const operation of entries) {
      const label = `${operation.operation === "duplicate_cleanup" ? "Duplicate cleanup" : "Manual removal"} · ${new Date(operation.created_at).toLocaleString()} · ${operation.deleted_track_count}/${operation.track_count} removed · restore ${operation.restore_status}`;
      operationsSelect.append(option(document, operation.id, label));
    }
    restorePreviewButton.disabled = current.stale || !current.connected || entries.length === 0;
  };

  const syncLibrary = async (successMessage = "Sync complete. Your snapshot is current."): Promise<string | null> => {
    syncButton.disabled = true;
    setStatus("Syncing your Spotify library…");
    let syncCompleted = false;
    try {
      await syncAndRefresh(
        async () => {
          await request<{ library: LibraryReport }>("/api/sync", {});
          syncCompleted = true;
        },
        async () => {
          approvedCleanup = null;
          cleanupPreview = null;
          cleanupCandidates.replaceChildren();
          cleanupPreviewPanel.replaceChildren();
          cleanupApplyBar.hidden = true;
          cleanupApplyButton.hidden = true;
          await refresh();
        },
        () => setStatus(successMessage),
      );
      return null;
    } catch (error) {
      const message = syncCompleted
        ? `${current.stale ? "Spotify sync completed, but the dashboard could not refresh" : "Spotify sync completed, but operation history could not refresh"}: ${errorMessage(error)}`
        : `Spotify sync failed: ${errorMessage(error)}`;
      setStatus(message, true);
      syncButton.disabled = !current.connected;
      return message;
    }
  };

  const previewDuplicateGroup = async (group: DuplicateGroup, button: HTMLButtonElement): Promise<void> => {
    if (current.stale) return;
    approvedCleanup = null;
    cleanupApplyButton.hidden = true;
    cleanupApplyBar.hidden = true;
    cleanupPreviewPanel.replaceChildren();
    for (const rowButton of document.querySelectorAll<HTMLButtonElement>(".duplicate-remove")) rowButton.disabled = true;
    button.textContent = "Preparing preview…";
    try {
      approvedCleanup = await request<CleanupPreview>("/api/cleanup/preview-group", { song_ids: group.song_ids });
      renderApprovedCleanup(document, cleanupPreviewPanel, approvedCleanup);
      cleanupApplyBar.hidden = false;
      cleanupApplyButton.hidden = false;
      cleanupApplyButton.disabled = current.stale || !current.connected;
      setInlineActionStatus(button, "Exact removal preview is shown above.");
      setStatus("Review the exact tracks above, then apply the cleanup.");
      cleanupApplyBar.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } catch (error) {
      const message = errorMessage(error);
      cleanupPreviewPanel.replaceChildren(el(document, "p", message, "load-error"));
      setInlineActionStatus(button, message, true);
      setStatus(message, true);
      cleanupPreviewPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } finally {
      for (const rowButton of document.querySelectorAll<HTMLButtonElement>(".duplicate-remove")) {
        rowButton.disabled = current.stale || !current.connected;
      }
      button.textContent = "Remove extras";
    }
  };

  const removeTrack = async (track: TrackSummary, button?: HTMLButtonElement): Promise<void> => {
    if (current.stale || !current.connected) return;
    const originalLabel = button?.textContent ?? "Remove";
    if (button) {
      button.disabled = true;
      button.textContent = "Removing…";
    }
    const confirmation = manualRemovalConfirmation(track.title, track.artists);
    if (!globalThis.confirm(`Remove “${track.title}” by ${track.artists.join(", ")}? Spotify will sync automatically after removal.`)) {
      if (button) {
        button.disabled = false;
        button.textContent = originalLabel;
      }
      return;
    }
    try {
      await request<unknown>(`/api/tracks/${encodeURIComponent(track.id)}/remove`, { confirmation_text: confirmation });
    } catch (error) {
      const message = errorMessage(error);
      if (button) {
        button.disabled = false;
        button.textContent = originalLabel;
        setInlineActionStatus(button, message, true);
      }
      setStatus(message, true);
      return;
    }

    current.stale = true;
    cleanupPreview = null;
    approvedCleanup = null;
    cleanupCandidates.replaceChildren();
    cleanupApplyBar.hidden = true;
    cleanupApplyButton.hidden = true;
    setSnapshotState();
    if (button) {
      button.textContent = "Removed";
      button.disabled = true;
      setInlineActionStatus(button, "Removed; syncing Spotify data…");
    }
    setStatus(`Removed “${track.title}”. Syncing Spotify data…`);
    const syncError = await syncLibrary(`Removed “${track.title}”. Library refreshed.`);
    if (syncError) {
      let message = `Removed “${track.title}”. ${syncError}`;
      try {
        await refreshOperations();
      } catch {
        message += "; operation history could not refresh";
      }
      setStatus(message, true);
      if (button) setInlineActionStatus(button, message, true);
    }
  };

  syncButton.addEventListener("click", async () => {
    await syncLibrary();
  });

  reviewButton.addEventListener("click", async () => {
    reviewButton.disabled = true;
    approvedCleanup = null;
    cleanupPreview = null;
    cleanupCandidates.replaceChildren();
    cleanupApplyBar.hidden = true;
    cleanupApplyButton.hidden = true;
    cleanupPreviewPanel.replaceChildren();
    try {
      cleanupPreview = await request<CleanupPreview>("/api/cleanup/preview", {});
      approvedCleanup = null;
      cleanupApplyBar.hidden = true;
      renderCleanupGroups(document, cleanupCandidates, cleanupPreview.groups, removeTrack, current.stale || !current.connected);
      reviewButton.disabled = current.stale;
    } catch (error) {
      const message = errorMessage(error);
      cleanupPreviewPanel.replaceChildren(el(document, "p", message, "load-error"));
      setStatus(message, true);
      cleanupPreviewPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
      reviewButton.disabled = current.stale || !current.library?.duplicates.length;
    }
  });

  get<HTMLButtonElement>(document, "cleanup-preview-button").addEventListener("click", async () => {
    if (!cleanupPreview || current.stale) return;
    approvedCleanup = null;
    cleanupApplyBar.hidden = true;
    cleanupApplyButton.hidden = true;
    const selected = [...cleanupCandidates.querySelectorAll<HTMLInputElement>("input[data-group-id]:checked")]
      .map((input) => input.dataset.groupId).filter((id): id is string => Boolean(id));
    if (!selected.length) {
      cleanupPreviewPanel.replaceChildren(el(document, "p", "Select at least one duplicate group.", "load-error"));
      cleanupPreviewPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
      return;
    }
    try {
      approvedCleanup = await request<CleanupPreview>("/api/cleanup/preview", { group_ids: selected });
      renderApprovedCleanup(document, cleanupPreviewPanel, approvedCleanup);
      cleanupApplyBar.hidden = false;
      cleanupApplyButton.hidden = false;
      cleanupApplyButton.disabled = current.stale || !current.connected;
      cleanupApplyBar.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } catch (error) {
      const message = errorMessage(error);
      cleanupPreviewPanel.replaceChildren(el(document, "p", message, "load-error"));
      setStatus(message, true);
      cleanupPreviewPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  });

  cleanupCandidates.addEventListener("change", () => {
    approvedCleanup = null;
    cleanupApplyBar.hidden = true;
    cleanupApplyButton.hidden = true;
    cleanupPreviewPanel.replaceChildren();
  });

  cleanupApplyButton.addEventListener("click", async () => {
    if (!approvedCleanup || current.stale) return;
    const preview = approvedCleanup;
    if (!globalThis.confirm(`Remove exactly ${preview.removal_count} older saved track${preview.removal_count === 1 ? "" : "s"}?\n\n${preview.confirmation_text}\n\nSpotify will sync automatically after removal.`)) return;
    cleanupApplyButton.disabled = true;
    try {
      await request<unknown>("/api/cleanup/apply", { preview_id: preview.preview_id, confirmation_text: preview.confirmation_text });
    } catch (error) {
      const message = errorMessage(error);
      cleanupPreviewPanel.replaceChildren(el(document, "p", message, "load-error"));
      setStatus(message, true);
      cleanupApplyButton.disabled = false;
      return;
    }
    current.stale = true;
    cleanupPreview = null;
    approvedCleanup = null;
    cleanupCandidates.replaceChildren();
    setSnapshotState();
    cleanupApplyButton.hidden = true;
    cleanupApplyBar.hidden = true;
    cleanupPreviewPanel.replaceChildren(el(document, "p", `Removed ${preview.removal_count} tracks. Syncing Spotify data…`, "helper"));
    setStatus(`Removed ${preview.removal_count} tracks. Syncing Spotify data…`);
    const syncError = await syncLibrary();
    if (syncError) {
      let message = `Removed ${preview.removal_count} tracks. ${syncError}`;
      try {
        await refreshOperations();
      } catch {
        message += "; operation history could not refresh";
      }
      cleanupPreviewPanel.replaceChildren(el(document, "p", message, "load-error"));
      setStatus(message, true);
    }
  });

  restorePreviewButton.addEventListener("click", async () => {
    const operationId = operationsSelect.value;
    if (!operationId || current.stale) return;
    restorePreviewButton.disabled = true;
    try {
      restorePreview = await request<RestorePreview>("/api/restore/preview", { operation_id: operationId });
      renderRestorePreview(document, restorePreviewPanel, restorePreview);
      restoreApplyButton.hidden = false;
      restoreApplyButton.disabled = false;
    } catch (error) {
      setStatus(errorMessage(error), true);
      restorePreviewButton.disabled = current.stale || !current.connected;
    }
  });

  restoreApplyButton.addEventListener("click", async () => {
    if (!restorePreview || current.stale) return;
    const preview = restorePreview;
    if (!globalThis.confirm(`Restore exactly ${preview.restore_count} missing track${preview.restore_count === 1 ? "" : "s"}? Original saved dates cannot be restored.\n\n${preview.confirmation_text}`)) return;
    restoreApplyButton.disabled = true;
    try {
      await request<unknown>("/api/restore/apply", { preview_id: preview.preview_id, confirmation_text: preview.confirmation_text });
      current.stale = true;
      restorePreview = null;
      setSnapshotState();
      setStatus(`Restored ${preview.restore_count} tracks. Sync before making more changes.`);
      await refreshOperations();
    } catch (error) {
      setStatus(errorMessage(error), true);
      restoreApplyButton.disabled = false;
    }
  });

  const search = get<HTMLInputElement>(document, "search");
  const sections = document.querySelectorAll<HTMLDetailsElement>(".dashboard-section");
  get<HTMLButtonElement>(document, "expand-all").addEventListener("click", () => { for (const section of sections) section.open = true; });
  get<HTMLButtonElement>(document, "collapse-all").addEventListener("click", () => { for (const section of sections) section.open = false; });
  search.addEventListener("input", () => filterLibrary(document, search.value));

  if (!current.library) showLoadError(document, "Loading your library…");
  setSnapshotState();
  void refresh().catch((error) => setStatus(errorMessage(error), true));
}

function parseEmbeddedReport(text: string): LibraryReport | null {
  try {
    const value: unknown = JSON.parse(text);
    return isLibraryReport(value) ? value : null;
  } catch {
    return null;
  }
}

function renderReport(document: Document, data: LibraryReport, removeTrack: (track: TrackSummary, button?: HTMLButtonElement) => void, previewDuplicateGroup: (group: DuplicateGroup, button: HTMLButtonElement) => void, showMutationControls: boolean, disableMutations = false): void {
  document.getElementById("load-error")?.remove();
  const statistics = data.statistics;
  const saved = statistics.saved_library;
  get<HTMLElement>(document, "liked-count").textContent = data.liked_track_count.toLocaleString();
  get<HTMLElement>(document, "unique-count").textContent = data.unique_song_count.toLocaleString();
  get<HTMLElement>(document, "duplicate-count").textContent = data.extra_duplicate_count.toLocaleString();
  get<HTMLElement>(document, "duplicate-summary").textContent = `${data.duplicate_song_count} groups · ${data.extra_duplicate_count} extra copies`;
  get<HTMLElement>(document, "generated").textContent = `Updated ${new Date(data.generated_at).toLocaleString()}`;

  const rankings = get<HTMLElement>(document, "rankings");
  rankings.replaceChildren();
  const rankingPeriods = Object.entries(statistics.top_rankings || {});
  if (!rankingPeriods.length) rankings.append(el(document, "p", "No Spotify ranking data is available yet.", "empty"));
  for (const [period, kinds] of rankingPeriods) {
    const card = el(document, "section", undefined, "rank-period");
    const heading = el(document, "h3", period.replaceAll("_", " "));
    heading.append(el(document, "span", kinds.label));
    card.append(heading);
    const columns = el(document, "div", undefined, "ranking-columns");
    for (const kind of ["artists", "tracks"] as const) {
      const column = el(document, "div");
      column.append(el(document, "h4", kind));
      const list = el(document, "ol", undefined, "ranking-list");
      const items: Array<{ label: string; url: string | null; detail: string }> = kind === "tracks"
        ? kinds.tracks.map((item) => ({ label: `${item.title} — ${item.artists.join(", ")}`, url: item.url, detail: item.album }))
        : kinds.artists.map((item) => ({ label: item.name ?? "Unknown artist", url: item.url, detail: item.genres.slice(0, 3).join(" · ") }));
      if (!items.length) list.append(el(document, "li", "No results"));
      for (const item of items) {
        const row = el(document, "li");
        appendLinkOrText(document, row, item.label, item.url);
        if (item.detail) row.append(el(document, "span", item.detail, "ranking-detail"));
        list.append(row);
      }
      column.append(list);
      columns.append(column);
    }
    card.append(columns);
    rankings.append(card);
  }

  const savedPanel = get<HTMLElement>(document, "saved-stats");
  savedPanel.replaceChildren();
  const runtimeHours = Math.round(saved.collection_runtime_ms / 3600000);
  savedPanel.append(el(document, "p", `${saved.track_count.toLocaleString()} saved tracks · ${saved.unique_track_count.toLocaleString()} unique · ${saved.artist_count.toLocaleString()} artists · ${saved.artist_album_count.toLocaleString()} artist-album pairs · ${runtimeHours.toLocaleString()} hours collection runtime (not listening time)`, "helper"));
  const savedCharts = el(document, "div", undefined, "chart-grid");
  savedCharts.append(renderBarChart(document, "Most saved artists", saved.top_artists, (item) => item.name, (item) => item.track_count, (value) => `${value} tracks`));
  savedCharts.append(renderBarChart(document, "Most saved artist-albums", saved.top_albums, (item) => `${item.artist} · ${item.name}`, (item) => item.track_count, (value) => `${value} tracks`));
  savedPanel.append(savedCharts);

  const recent = get<HTMLElement>(document, "recent");
  recent.replaceChildren();
  const recentPlays = statistics.recently_played || [];
  const recentTracks = statistics.most_played_recent_tracks || [];
  const recentArtists = statistics.most_played_recent_artists || [];
  const recentCount = statistics.recent_play_count || 0;
  get<HTMLElement>(document, "recent-count").textContent = `${recentCount} of up to ${statistics.recent_play_limit || 50} plays`;
  recent.append(el(document, "p", `Frequency counts and latest plays cover this sample of ${recentCount} items only; they are not measured listening time.`, "helper"));
  const recentCharts = el(document, "div", undefined, "chart-grid");
  recentCharts.append(renderBarChart(document, "Most frequent tracks in this sample", recentTracks, (item) => `${item.title} · ${item.artists.join(", ")}`, (item) => item.plays, (value) => `${value} plays`));
  recentCharts.append(renderBarChart(document, "Most frequent artists in this sample", recentArtists, (item) => item.name, (item) => item.plays, (value) => `${value} plays`));
  recent.append(recentCharts, el(document, "h3", "Latest plays", "latest-heading"));
  if (!recentPlays.length) recent.append(el(document, "p", "No recent plays returned by Spotify.", "empty"));
  else {
    const list = el(document, "ol", undefined, "recent-list");
    for (const play of recentPlays.slice(0, 10)) {
      const timeText = play.played_at ? new Date(play.played_at).toLocaleString() : "Time unavailable";
      const row = el(document, "li");
      const time = el(document, "time", timeText, "played-at");
      if (play.played_at) time.dateTime = play.played_at;
      row.append(time, el(document, "span", `${play.title} — ${play.artists.join(", ")}`, "played-track"));
      list.append(row);
    }
    recent.append(list);
  }

  const duplicateRows = get<HTMLElement>(document, "duplicate-rows");
  duplicateRows.replaceChildren();
  for (const duplicate of data.duplicates) {
    const row = el(document, "tr");
    row.append(el(document, "td", duplicate.title), el(document, "td", `${duplicate.artists.join(", ")} · ${duplicate.album}`));
    const count = el(document, "td");
    count.append(el(document, "span", String(duplicate.copies), "pill"));
    row.append(count);
    if (showMutationControls) {
      const action = el(document, "td");
      const button = el(document, "button", "Remove extras", "small-button duplicate-remove");
      button.type = "button";
      button.disabled = disableMutations;
      button.setAttribute("aria-label", `Preview removal of extra copies of ${duplicate.title} by ${duplicate.artists.join(", ")}`);
      button.addEventListener("click", () => previewDuplicateGroup(duplicate, button));
      action.append(button);
      row.append(action);
    }
    duplicateRows.append(row);
  }
  get<HTMLElement>(document, "no-duplicates").hidden = data.duplicates.length !== 0;

  const artistList = get<HTMLElement>(document, "artist-list");
  artistList.replaceChildren();
  for (const artist of data.artists) {
    const details = el(document, "details", undefined, "artist");
    const summary = el(document, "summary", artist.name);
    const songCount = artist.albums.reduce((total, album) => total + album.songs.length, 0);
    summary.append(el(document, "span", `${artist.albums.length} albums · ${songCount} tracks`, "artist-count"));
    details.append(summary);
    for (const album of artist.albums) {
      const section = el(document, "section", undefined, "album");
      section.append(el(document, "h3", album.name));
      const list = el(document, "ul", undefined, "songs");
      for (const song of album.songs) {
        const item = el(document, "li");
        appendLinkOrText(document, item, song.title, song.url);
        if (song.artists.length > 1) item.append(el(document, "span", song.artists.join(", "), "count"));
        if (showMutationControls && song.spotify_id && song.added_at) {
          const button = el(document, "button", "Remove", "small-button manual-remove");
          button.type = "button";
          button.disabled = disableMutations;
          button.setAttribute("aria-label", `Remove ${song.title} by ${song.artists.join(", ")}`);
          const track: TrackSummary = { id: song.spotify_id, added_at: song.added_at, title: song.title, artists: song.artists, album: song.album };
          button.addEventListener("click", () => removeTrack(track, button));
          item.append(button);
        }
        list.append(item);
      }
      section.append(list);
      details.append(section);
    }
    artistList.append(details);
  }
}

function renderCleanupGroups(document: Document, container: HTMLElement, groups: CleanupPreview["groups"], removeTrack: (track: TrackSummary, button?: HTMLButtonElement) => void, disableMutations: boolean): void {
  container.replaceChildren();
  for (const { group_id: groupId, plan } of groups) {
    const section = el(document, "section", undefined, "cleanup-group");
    const label = el(document, "label", undefined, "cleanup-choice");
    const checkbox = el(document, "input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
    checkbox.dataset.groupId = groupId;
    label.append(checkbox, el(document, "span", `${plan.group.title} · ${plan.group.artists.join(", ")} · ${plan.group.copies} copies`));
    section.append(label);
    section.append(trackDescription(document, "Keep newest", plan.keep));
    const removeList = el(document, "ul", undefined, "cleanup-remove-list");
    for (const track of plan.remove) {
      const item = el(document, "li");
      item.append(el(document, "span", `${track.title} — ${track.artists.join(", ")} · ${track.album} · saved ${new Date(track.added_at).toLocaleDateString()}`));
      const button = el(document, "button", "Remove this track only", "small-button manual-remove");
      button.type = "button";
      button.disabled = disableMutations;
      button.addEventListener("click", () => removeTrack(track, button));
      item.append(button);
      removeList.append(item);
    }
    section.append(removeList);
    container.append(section);
  }
}

function renderApprovedCleanup(document: Document, panel: HTMLElement, preview: CleanupPreview): void {
  panel.replaceChildren(el(document, "p", `Preview: exactly ${preview.removal_count} saved track${preview.removal_count === 1 ? "" : "s"} will be removed.`, "helper"));
  for (const { plan } of preview.groups) {
    const section = el(document, "section", undefined, "cleanup-group");
    section.append(el(document, "h3", `${plan.group.title} · ${plan.group.artists.join(", ")}`));
    section.append(trackDescription(document, "Keep", plan.keep));
    for (const track of plan.remove) section.append(trackDescription(document, "Remove", track));
    panel.append(section);
  }
  panel.append(el(document, "p", `Confirmation: ${preview.confirmation_text}`, "helper"));
}

function renderRestorePreview(document: Document, panel: HTMLElement, preview: RestorePreview): void {
  panel.replaceChildren(el(document, "p", `Restore exactly ${preview.restore_count} tracks. Their original saved dates cannot be recovered.`, "helper"));
  for (const track of preview.tracks) panel.append(trackDescription(document, "Restore", track));
  panel.append(el(document, "p", `Confirmation: ${preview.confirmation_text}`, "helper"));
}

function trackDescription(document: Document, label: string, track: TrackSummary): HTMLElement {
  return el(document, "p", `${label}: ${track.title} — ${track.artists.join(", ")} · ${track.album} · saved ${new Date(track.added_at).toLocaleDateString()}`, "helper");
}

function renderBarChart<T>(document: Document, title: string, entries: T[], labelFor: (item: T) => string, valueFor: (item: T) => number, valueLabel: (value: number) => string): HTMLElement {
  const card = el(document, "section", undefined, "chart-card");
  card.append(el(document, "h3", title));
  if (!entries.length) {
    card.append(el(document, "p", "No data available for this view yet.", "empty"));
    return card;
  }
  const maximum = Math.max(1, ...entries.map((item) => Number(valueFor(item)) || 0));
  const list = el(document, "ol", undefined, "bar-chart");
  for (const item of entries) {
    const value = Number(valueFor(item)) || 0;
    const row = el(document, "li", undefined, "bar-row");
    const label = el(document, "div", undefined, "bar-label");
    label.append(el(document, "span", labelFor(item), "bar-name"), el(document, "span", valueLabel(value), "bar-value"));
    const track = el(document, "span", undefined, "bar-track");
    track.setAttribute("aria-hidden", "true");
    const fill = el(document, "span", undefined, "bar-fill");
    fill.style.width = `${value / maximum * 100}%`;
    track.append(fill);
    row.append(label, track);
    list.append(row);
  }
  card.append(list);
  return card;
}

function filterLibrary(document: Document, rawQuery: string): void {
  const query = rawQuery.trim().toLocaleLowerCase();
  for (const artist of get<HTMLElement>(document, "artist-list").children) {
    const artistMatches = artist.querySelector("summary")?.textContent?.toLocaleLowerCase().includes(query) ?? false;
    for (const album of artist.querySelectorAll<HTMLElement>(".album")) {
      const albumMatches = album.querySelector("h3")?.textContent?.toLocaleLowerCase().includes(query) ?? false;
      let visibleSongs = 0;
      for (const song of album.querySelectorAll<HTMLElement>("li")) {
        const matches = !query || artistMatches || albumMatches || (song.textContent ?? "").toLocaleLowerCase().includes(query);
        song.hidden = !matches;
        if (matches) visibleSongs++;
      }
      album.hidden = Boolean(query) && !artistMatches && !albumMatches && visibleSongs === 0;
    }
    const visibleAlbum = [...artist.querySelectorAll<HTMLElement>(".album")].some((album) => !album.hidden);
    (artist as HTMLElement).hidden = Boolean(query) && !artistMatches && !visibleAlbum;
  }
}

function appendLinkOrText(document: Document, parent: HTMLElement, text: string, rawUrl: string | null): void {
  const url = safeSpotifyUrl(rawUrl);
  if (!url) {
    parent.append(el(document, "span", text));
    return;
  }
  const link = el(document, "a", text);
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  parent.append(link);
}

function showLoadError(document: Document, message: string): void {
  const node = document.querySelector("main");
  if (!node) return;
  const error = document.getElementById("load-error") ?? el(document, "p", undefined, "load-error");
  error.id = "load-error";
  error.textContent = message;
  if (error.parentElement !== node) node.prepend(error);
}

function setInlineActionStatus(button: HTMLButtonElement, message: string, error = false): void {
  const parent = button.parentElement;
  if (!parent) return;
  const status = parent.querySelector<HTMLElement>(":scope > .inline-action-status") ?? el(button.ownerDocument, "span", undefined, "inline-action-status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.textContent = message;
  status.classList.toggle("error", error);
  if (!status.parentElement) button.after(status);
}

function option(document: Document, value: string, text: string): HTMLOptionElement {
  const result = document.createElement("option");
  result.value = value;
  result.textContent = text;
  return result;
}

function get<T extends HTMLElement>(document: Document, id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Dashboard element ${id} is missing.`);
  return element as T;
}

function el<K extends keyof HTMLElementTagNameMap>(document: Document, tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The request failed.";
}

if (typeof document !== "undefined") startDashboard(document);
