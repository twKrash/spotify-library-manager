export const group = (songIds: string[], title = "Song", artists = ["Alpha"], copies = Math.max(2, songIds.length)) => ({
  song_ids: songIds,
  isrcs: [],
  title,
  artists,
  album: "Album",
  copies,
  extra_copies: copies - 1,
});

export const song = (id: string, songId: string, addedAt: string, title = "Song", artists = ["Alpha"], album = "Album") => ({
  title,
  artists,
  album,
  spotify_id: id,
  duration_ms: 1000,
  isrc: null,
  song_id: songId,
  url: `https://open.spotify.com/track/${id}`,
  added_at: addedAt,
});

export const library = (songs = [
  song("old", "song-key", "2023-01-01T00:00:00Z"),
  song("new", "song-key", "2024-01-01T00:00:00Z"),
], duplicates = [group(["song-key"])]) => ({
  generated_at: "2024-01-02T00:00:00Z",
  liked_track_count: songs.length,
  duplicates,
  artists: [{
    name: "Alpha",
    albums: [{ name: "Album", songs }],
  }],
});
