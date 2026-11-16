# Player action discovery

The engine's `inspectPlayerAction` reads the same announcement, pending-choice and final validation rules used to submit a player command. The server publishes these results to the ordinary game client and to assigned Test Lab seats.

| Surface | What it provides |
| --- | --- |
| `PlayerView.legalActions` | Available room controls and a combat declaration draft, if the viewer owns one. |
| `CardView.actions` or `getOptions` | Cast, land, mana and activated ability candidates. An enabled option without `nextInput` has passed validation. An option with `nextInput` identifies the first input to collect. |
| `PlayerView.pendingChoice` | The active decision and its exact option handles or numeric bounds for the answering seat. |
| `inspectPlayerAction` socket acknowledgement | Read-only validation of a concrete packet or a description of the next input for an incomplete command. |

Send the same versioned fields to inspection and submission. For example, first inspect `{ protocolVersion: 1, roomId, actionId: 'cast_spell', cardUuid }`. The response is `ready`, `unavailable` with a reason, `combat` with declaration candidates, or `input` with typed choice constraints. A valid preview can require another input before the completed action can be validated. Inspecting X gives its declared numeric bounds, and inspecting a chosen X checks that value and its resulting costs. No candidate values are sampled for player discovery. A completed material payment is unavailable when the current replacement rules prevent it. If a replacement decision is still required, submitting the action opens that decision before any cost is committed.

To answer a preview, first submit the associated action so the server opens the live choice. For a pending choice, inspect `{ protocolVersion: 1, roomId, actionId: 'choose' }` to read it or include the current `choiceId` and answer to inspect that answer. Preview choices have an empty ID. Use the live choice ID and its option handles in a submission. For ordering, send `choices` in the intended order. For distribution or mana payment, send `allocations` keyed by option handle. An answer may admit a follow-up decision during resolution. Inspection does not resolve effects, generate IDs, publish events, or spend resources.

For combat, inspect `declare_attackers` or `declare_blockers` without a declaration to read draft candidates. To validate the entire declaration send `attackers` or `assignments`, including an empty array when passing the declaration. This checks whole-declaration rules such as flying and creatures that must attack together. Every real submission is checked against the current room.

In process, a bot can call `GameEngine.inspectPlayerAction`. A seated socket consumer uses the same projection and identifiers as the player client. Card action IDs and private choices are scoped to the normal per-seat projection. Debug controls follow the room's debug mode. Opening RPS is a lobby action.

## Bounded auto-pass query

Implemented 2026-11-03. Source: packages/engine/src/engine/legal-actions.ts. This implements the engine query proposed in the [room lifecycle and auto-pass assessment](room-lifecycle-and-auto-pass.md); the [opt-in five-second auto-pass coordinator](auto-pass-controls.md) now consumes it.

### API and contract

```ts
import { hasLegalNonPassAction } from '@card-game/engine/engine/legal-actions';

const result = hasLegalNonPassAction(room, playerId, { maxNodes: 512 });
switch (result.kind) {
  case 'available':
    // result.action = { actionId, data }: a complete, handler-validated witness.
    break;
  case 'none':
    // All supported ordinary gameplay candidates were rejected exhaustively.
    break;
  case 'unknown':
    // Never authorize auto-pass: the position is not ready or search is incomplete.
    break;
}
```

The function reads authoritative room data without changing it, executing an action, opening a live choice, emitting mutations/events, consuming usage, allocating UUIDs or reading randomness/time. Witnesses are illustrative legal selections, not instructions to play them automatically; they must be revalidated against current state before use. Full room inputs and private witnesses belong on the server, not in opponent/public projections.

The domain is ordinary built-in casting from hand, land plays, battlefield mana abilities, and non-mana activated abilities from supported hand/battlefield sources, including effective granted abilities. Concede, pass, debug/turn shortcuts, RPS and combat declarations are deliberately excluded. An application with custom registered gameplay actions must also query those extensions; this function alone cannot certify their absence.

### Reused rules and bounded exploration

Candidate discovery uses effective characteristics and the existing mana-ability classifier. It does not trust OptionService previews or a mere nonempty hand. For each candidate, prepareActionChoice describes the same announcement prompts used by the engine. The query enumerates answers, validates them with validateChoiceAnswer, folds them with applyActionChoice, and repeats preparation in continuing mode until complete. Only the ordinary action handler's successful validation produces an available witness.

This reuses current casting/activation permissions, timing, targets and target groups, modes, alternative/additional costs, discard selection, distributions, floating-mana payment, numeric bindings, cast modifiers and ability-use limits. Ordered selections cover order-sensitive modes and targets. Optional effects chosen during resolution need not be executable now to make casting/activation legal; availability concerns the action's announcement, not whether it will eventually have a useful effect.

A payable mana activation itself proves an available action. The query need not simulate chaining mana abilities into a later cast: the first such activation is already a legal non-pass action. It never spends that mana. Disabled or exhausted mana abilities do not provide a witness.

Exploration is bounded to 512 nodes by default; callers may choose an integer from 1 to 8192. Selection/allocation recursion and announcement depth are capped at 32. Numeric prompts sample up to 32 consecutive safe integers from their minimum. If further admissible values remain, failed samples return `unknown`. Resource/depth exhaustion likewise returns unknown. An available witness wins even if an earlier branch was incomplete, provided the remaining budget permits finding it. Finishing the last exhausted candidate exactly at the budget boundary may prove `none`. An unfinished selection or payment search still returns `unknown` at that boundary. For example, testing one ritual material with too little mana value cannot rule out a legal combination of two materials.

Unknown reasons are not_ready, search_limit, number_range_limit and unsupported_choice. Unexpected invalid content/plugin exceptions remain errors, never evidence of no action.

### Safe call window

The room must be playing and unfinished, idle in waiting_for_player, owned by a seated player with priority, and have no pending choice, trigger queue, queued trigger mutations or required combat declaration. Otherwise the answer is unknown/not_ready. Even a player who can concede during a choice must not auto-pass that choice.

Because this is a room-only query, the caller must additionally ensure the engine's private rules checkpoint/collector is settled before calling. A future auto-pass coordinator must recheck that, connection/preference and current state before invoking pass_priority. The subsequent auto-pass coordinator owns opt-in UX, connection checks and a fresh five-second timer for each pass; this pure query still changes no game state.

### Verification of the original auto-pass query

Focused logic tests check frozen-input purity/determinism and actual engine execution of returned witnesses. Cases cover empty priority/stack windows, free spells and abilities, colored mana, tapped/sick/opponent mana sources, hand activation, land allowances, instant/sorcery timing, use limits, missing/hexproof targets, multiple groups, modes, alternative/additional costs, finite/open X ranges, cast modifiers, distributions, gating and exact resource-budget boundaries. Existing cost-route, target-group and numeric-announcement regressions and the import boundary gate are included.

No smoke test, long socket scenario or full suite is required. The existing moved checkout contains unrelated untracked duplicate files, so readability is also checked against tracked engine sources plus the new query without raising any budget or modifying the duplicates.

Verification: 152 passing focused tests across nine files (including the temporary tracked-source readability check), all TypeScript projects and the server build. Existing duplicate files remain untouched; no readability budgets were raised.
