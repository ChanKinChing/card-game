// src/client/store/combatSelection.ts
// Client-only combat selection state and reconciliation logic.
// Holds local UUID selections; reconciles against server state on every delta.

import type { PlayerView } from '@card-game/protocol';

export interface CombatSelection {
  attackers: string[];                       // selected attacker uuids
  blockerPairs: { attackerUuid: string; blockerUuid: string }[];
  pendingBlocker: string | null;             // blocker awaiting an attacker click
}

export const EMPTY_COMBAT_SELECTION: CombatSelection = {
  attackers: [],
  blockerPairs: [],
  pendingBlocker: null,
};

/**
 * Reconcile local combat selection against the latest server state.
 * Drops any reference to cards that no longer exist or are no longer eligible.
 * Returns the reconciled selection and a `changed` flag for UI notification.
 * Pure function — testable independently of Zustand.
 */
export function reconcileCombatSelection(
  selection: CombatSelection,
  room: PlayerView,
): { selection: CombatSelection; changed: boolean } {
  const declaration = room.legalActions?.combat;
  const defendingPlayerId = room.activeTurnPlayerId === room.player1Id ? room.player2Id : room.player1Id;
  const eligibleAttackers = new Set(room.legalActions
    ? declaration?.actionId === 'declare_attackers' ? declaration.attackerUuids : []
    : room.battlefield.filter(card => card.state.controllerId === room.activeTurnPlayerId && card.canAttack).map(card => card.uuid));
  const eligibleBlockers = new Set(room.legalActions
    ? declaration?.actionId === 'declare_blockers' ? declaration.blockerUuids : []
    : room.battlefield.filter(card => card.state.controllerId === defendingPlayerId && card.canBlock).map(card => card.uuid));
  const combatAttackerUuids = new Set(room.legalActions
    ? declaration?.actionId === 'declare_blockers' ? declaration.attackerUuids : []
    : room.combat.map(group => group.uuid));
  const attackersOpen = room.status === 'playing' && room.phase === 'declareAttackersStep' && !room.combatDeclarations?.attackers;
  const blockersOpen = room.status === 'playing' && room.phase === 'declareBlockersStep' && !room.combatDeclarations?.blockers;
  const reconciledAttackers = attackersOpen ? selection.attackers.filter(uuid => eligibleAttackers.has(uuid)) : [];
  const reconciledPairs = blockersOpen ? selection.blockerPairs.filter(
    pair =>
      combatAttackerUuids.has(pair.attackerUuid) &&
      eligibleBlockers.has(pair.blockerUuid),
  ) : [];
  const reconciledPending =
    blockersOpen && selection.pendingBlocker && eligibleBlockers.has(selection.pendingBlocker)
      ? selection.pendingBlocker
      : null;

  const changed =
    reconciledAttackers.length !== selection.attackers.length ||
    reconciledPairs.length !== selection.blockerPairs.length ||
    reconciledPending !== selection.pendingBlocker;

  return {
    selection: {
      attackers: reconciledAttackers,
      blockerPairs: reconciledPairs,
      pendingBlocker: reconciledPending,
    },
    changed,
  };
}
