import { describe, expect, it } from 'vitest';
import { reconcileCombatSelection, type CombatSelection } from '@client/store/combatSelection';
import { createTestRoom, creature, instantiateCard } from '../helpers/client-view-fixture';

describe('combat selection reconciliation for the second seat', () => {
  it('retains an eligible pending blocker and block pair when the active player is the opponent', () => {
    const room = createTestRoom({ phase: 'declareBlockersStep', activeTurnPlayerId: 'player2' });
    const attacker = instantiateCard('empire-servant');
    attacker.state.controllerId = 'player2';
    attacker.state.ownerId = 'player2';
    const blocker = instantiateCard('empire-servant');
    blocker.state.controllerId = 'player1';
    blocker.state.isTapped = false;
    blocker.canBlock = true;
    room.battlefield = [blocker];
    room.combat = [{ uuid: attacker.uuid, attacker, attackerPower: 1, blockers: [], blocked: false }];

    room.legalActions = { actions: ['concede'], combat: { actionId: 'declare_blockers', attackerUuids: [attacker.uuid], blockerUuids: [blocker.uuid] } };
    const selection: CombatSelection = {
      attackers: [],
      blockerPairs: [{ attackerUuid: attacker.uuid, blockerUuid: blocker.uuid }],
      pendingBlocker: blocker.uuid,
    };

    const { selection: result, changed } = reconcileCombatSelection(selection, room);

    expect(result).toEqual(selection);
    expect(changed).toBe(false);
  });

  it('keeps the pending blocker only while the block declaration is open', () => {
    const room = createTestRoom({ phase: 'declareBlockersStep', activeTurnPlayerId: 'player2', combatDeclarations: { attackers: true, blockers: true } });
    const blocker = instantiateCard('empire-servant');
    blocker.state.controllerId = 'player1';
    blocker.canBlock = true;
    room.battlefield = [blocker];

    const { selection: result, changed } = reconcileCombatSelection({ attackers: [], blockerPairs: [], pendingBlocker: blocker.uuid }, room);

    expect(result.pendingBlocker).toBeNull();
    expect(changed).toBe(true);
  });

  it('keeps only eligible attackers for the active first seat', () => {
    const room = createTestRoom({ phase: 'declareAttackersStep', activeTurnPlayerId: 'player1' });
    const card = instantiateCard('empire-servant');
    card.state.controllerId = 'player1';
    card.state.isTapped = false;
    card.state.summoningSickness = false;
    card.state.attackedThisTurn = false;
    card.canAttack = true;
    card.canBlock = true;
    room.battlefield.push(card);
    room.legalActions = { actions: ['concede'], combat: { actionId: 'declare_attackers', attackerUuids: [card.uuid] } };

    const { selection: result, changed } = reconcileCombatSelection(
      { attackers: [card.uuid, 'departed'], blockerPairs: [], pendingBlocker: null },
      room,
    );

    expect(result.attackers).toEqual([card.uuid]);
    expect(changed).toBe(true);
  });
});


describe('combat selection with a cached view that predates legal action drafts', () => {
  it('uses the active player’s visible eligible creatures for attack selection', () => {
    const room = createTestRoom({ phase: 'declareAttackersStep', activeTurnPlayerId: 'player2' });
    delete room.legalActions;
    const ready = { ...creature('ready', 'player2'), canAttack: true };
    const tapped = { ...creature('tapped', 'player2'), canAttack: false };
    const enemy = { ...creature('enemy', 'player1'), canAttack: true };
    room.battlefield = [ready, tapped, enemy];
    const draft = { attackers: [ready.uuid, tapped.uuid, enemy.uuid], blockerPairs: [], pendingBlocker: null };
    expect(reconcileCombatSelection(draft, room)).toEqual({
      selection: { ...draft, attackers: [ready.uuid] }, changed: true,
    });
  });

  it('uses the current attackers and the correct defending seat for a block draft', () => {
    const room = createTestRoom({ phase: 'declareBlockersStep', activeTurnPlayerId: 'player2' });
    delete room.legalActions;
    const attacker = { ...creature('attacker', 'player2'), canBlock: true };
    const ready = { ...creature('ready', 'player1'), canBlock: true };
    const tapped = { ...creature('tapped', 'player1'), canBlock: false };
    room.battlefield = [attacker, ready, tapped];
    room.combat = [{ uuid: attacker.uuid, attacker, attackerPower: 2, blockers: [], blocked: false }];
    const assigned = { attackerUuid: attacker.uuid, blockerUuid: ready.uuid };
    const draft = { attackers: [], blockerPairs: [assigned, { ...assigned, blockerUuid: tapped.uuid },
      { ...assigned, blockerUuid: attacker.uuid }, { ...assigned, attackerUuid: 'removed' }], pendingBlocker: ready.uuid };
    expect(reconcileCombatSelection(draft, room)).toEqual({
      selection: { ...draft, blockerPairs: [assigned] }, changed: true,
    });
  });
});
