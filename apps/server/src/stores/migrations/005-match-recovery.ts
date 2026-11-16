export const matchRecoverySchema = `
CREATE TABLE active_matches (
  room_id TEXT PRIMARY KEY,
  format_version INTEGER NOT NULL,
  checkpoint TEXT NOT NULL,
  checkpoint_hash TEXT NOT NULL,
  checkpoint_ordinal INTEGER NOT NULL,
  checkpoint_seq INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  view_seq INTEGER NOT NULL,
  state_hash TEXT NOT NULL
) STRICT;
CREATE TABLE match_commands (
  room_id TEXT NOT NULL REFERENCES active_matches(room_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  player_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  entry TEXT NOT NULL,
  PRIMARY KEY (room_id, ordinal),
  UNIQUE (room_id, player_id, command_id)
) STRICT;
CREATE TABLE match_seats (
  room_id TEXT NOT NULL REFERENCES active_matches(room_id) ON DELETE CASCADE,
  player_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  account_id TEXT REFERENCES accounts(id),
  PRIMARY KEY (room_id, player_id),
  UNIQUE (room_id, owner)
) STRICT;
`;
