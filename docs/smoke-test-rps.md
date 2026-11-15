# RPS and first turn — browser smoke test

1. Open two game tabs with separate sessions. Create a room and join it with the second tab. Both tabs should show Rock, Paper, and Scissors buttons with empty hands and graveyards.
2. Pick Rock in the first tab. It shows a locked pick; the second tab only shows that the opponent is ready. Refresh the first tab and confirm the pick is still locked.
3. Pick Paper in the second tab. Both tabs see the two choices and seat two going first. The match opens at upkeep with real hands, empty graveyards, and no opening buttons.
4. Pass through upkeep and the first draw step. Check that the configured first-turn draw rule is respected. Repeat with equal picks and verify that seat one goes first.
5. In a new room, leave after one pick. Both tabs return to the lobby without a concede result.
