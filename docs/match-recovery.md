# Durable match recovery

With a SQLite database configured, an ordinary match becomes recoverable when the opening round finishes. The opening checkpoint keeps the dealt hands, library order, current priority and both seat owners. Waiting lobbies and Test Lab runs are process-local. The existing reconnect grace period still applies to rooms that disconnect while the server is running.

Each accepted player command commits to SQLite before the room update is published. The journal stores the command, the UUIDs and random values it consumed, and checksums of the resulting state and engine event batches. A checkpoint is saved at the opening, every 32 accepted commands and at the match outcome. Journal entries remain available until the room closes so an already accepted command ID can be recognized after checkpoint rollover.

At startup the server loads each compatible checkpoint, replays its journal tail through the game engine and compares the recorded state, events and update sequence. A mismatch keeps that room unavailable and logs its ID and the recovery failure. It does not prevent unrelated rooms from loading. Reconnecting players use their existing credentials and receive a fresh, private snapshot at the saved sequence. That snapshot includes any live choice for its owner and current handles for its options.

Resending an accepted command ID from the same seat returns a room snapshot. If saving a new command fails, the in-memory engine returns to the prior committed room and the player can retry. Live clients can request a fresh snapshot if an update fails to reach them.

Migration 005 adds match checkpoints, commands and seat ownership to the existing SQLite database. Use one running game server per database. The recovery format is versioned. Deployments that change the engine in a way that breaks journal replay need a format migration or must let those matches finish before upgrade. The diagnostic JSONL remains useful for troubleshooting.

The restart tests cover priority, private choices, the stack, the finished outcome, duplicate submissions, missing journal entries and failed writes. A restart test removes a committed journal row from a temporary SQLite database and verifies that an unrelated match still resumes and accepts its next command. A separate test replays a real library shuffle and rejects a mismatched event record.
