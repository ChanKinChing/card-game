import { describe, expect, it, vi } from 'vitest';
import { GameEngine } from '@engine/game-engine';
import { discoverPlayerControls } from '@engine/player-action-query';
import { CombatRuleRegistry } from '@engine/combat-rules';
import { startCombatDamage } from '@engine/combat-service';
import { gameReducer } from '@engine/game-reducer';
import { parseCardDefinition } from '@library/card-parser';
import { createTestRoom } from '../helpers/test-room-factory';
import { creature } from '../helpers/combat-fixture';

const p1 = 'player1', p2 = 'player2';

describe('engine-backed player action discovery', () => {
  it('previews the next attacker’s damage assignment without making the first one', () => {
    const a = creature('first', p1, 2, 3), b = creature('second', p1, 3, 3);
    const room = createTestRoom({
      phase: 'combatDamageStep', battlefield: [a, b],
      combatDeclarations: { attackers: true, blockers: true },
      combat: [a, b].map(attacker => ({ uuid: attacker.uuid, attacker, attackerPower: attacker.blueprint.power!, blockers: [] })),
    });
    const plan = startCombatDamage(room);
    if (plan.kind !== 'prompt') throw new Error('Expected a combat assignment');
    const prepared = plan.mutations.reduce(gameReducer, room);
    const first = { ...plan.choice, id: 'first-assignment' };
    const engine = new GameEngine({ ...prepared, pendingChoice: first });
    engine.initRoom();
    try {
      const answer = { choiceId: first.id, allocations: { 'player:player2': 2 } };
      expect(engine.inspectPlayerAction(p1, 'choose', answer)).toMatchObject({
        kind: 'input', choice: { kind: 'distribution', total: 3, continuation: { sourceUuid: b.uuid } },
      });
      expect(engine.roomState.pendingChoice).toBe(first);
      expect(engine.roomState.players[p2].life).toBe(20);
      expect(engine.executePlayerAction(p1, 'choose', answer).success).toBe(true);
      expect(engine.roomState.pendingChoice).toMatchObject({ kind: 'distribution', total: 3 });
    } finally { engine.dispose(); }
  });

  it('blocks priority commands while accepted trigger work waits for an engine checkpoint', () => {
    const room = createTestRoom({ triggerQueue: { entries: [], resumePriority: p1 } });
    const engine = new GameEngine(room);
    try {
      expect(engine.inspectPlayerAction(p1, 'pass_priority')).toEqual({
        kind: 'unavailable', reason: 'Rules checkpoint is pending',
      });
      expect(engine.executePlayerAction(p1, 'pass_priority')).toMatchObject({
        success: false, reason: 'Rules checkpoint is pending',
      });
      expect(engine.roomState).toBe(room);
    } finally { engine.dispose(); }
  });

  it('describes large open numeric inputs and validates a particular value without touching a room', () => {
    const room = createTestRoom();
    const card = room.players[p1].hand[0];
    card.blueprint = parseCardDefinition({
      schemaVersion: 1, id: 'wide-x', cardTypes: ['Spell'], manaCost: '{X}',
      numericDeclarations: [{ name: 'X', min: 0 }],
    });
    room.players[p1].mana.red = 64;
    const uuid = vi.fn(() => 'generated-choice'), random = vi.fn(() => 0.5);
    const engine = new GameEngine(room, { uuid, random });
    const data = { cardUuid: card.uuid };
    expect(engine.inspectPlayerAction(p1, 'cast_spell', data)).toMatchObject({
      kind: 'input', choice: { kind: 'number', range: { min: 0 } },
    });
    expect(engine.inspectPlayerAction(p1, 'cast_spell', { ...data, numericBindings: { X: 40 } })).toEqual({ kind: 'ready' });
    expect(engine.inspectPlayerAction(p1, 'cast_spell', { ...data, numericBindings: { X: 100 } })).toMatchObject({ kind: 'unavailable' });
    expect(engine.roomState).toBe(room);
    expect(engine.drainEventBatches()).toEqual([]);
    expect(uuid).not.toHaveBeenCalled();
    expect(random).not.toHaveBeenCalled();

    expect(engine.executePlayerAction(p1, 'cast_spell', data).success).toBe(true);
    const choiceId = engine.roomState.pendingChoice!.id;
    expect(engine.inspectPlayerAction(p2, 'choose')).toMatchObject({ kind: 'unavailable' });
    expect(engine.inspectPlayerAction(p1, 'choose', { choiceId: 'stale', number: 40 })).toMatchObject({ kind: 'unavailable' });
    expect(engine.inspectPlayerAction(p1, 'choose', { choiceId, number: 100 })).toMatchObject({ kind: 'unavailable' });
    expect(engine.inspectPlayerAction(p1, 'choose', { choiceId, number: 40 })).toEqual({ kind: 'ready' });
    expect(engine.roomState.pendingChoice?.id).toBe(choiceId);
    expect(engine.executePlayerAction(p1, 'choose', { choiceId, number: 40 }).success).toBe(true);
    expect(engine.roomState.stack[0]?.numericBindings).toEqual({ X: 40 });
  });

  it('keeps an open announcement private and leaves the card untouched when it is canceled', () => {
    const room = createTestRoom();
    const card = room.players[p1].hand[0];
    card.blueprint = parseCardDefinition({
      schemaVersion: 1, id: 'cancelable-x', cardTypes: ['Spell'], manaCost: '{X}',
      numericDeclarations: [{ name: 'X', min: 0 }],
    });
    const engine = new GameEngine(room);
    try {
      expect(engine.inspectPlayerAction(p1, 'choose')).toEqual({ kind: 'unavailable', reason: 'No choice is pending' });
      expect(engine.executePlayerAction(p1, 'cast_spell', { cardUuid: card.uuid }).success).toBe(true);
      const pending = engine.roomState.pendingChoice!;
      expect(engine.inspectPlayerAction(p1, 'choose')).toEqual({ kind: 'input', choice: pending });
      expect(engine.inspectPlayerAction(p2, 'choose')).toEqual({ kind: 'unavailable', reason: 'This choice belongs to another player' });
      expect(engine.inspectPlayerAction(p1, 'pass_priority')).toEqual({ kind: 'unavailable', reason: 'A choice is pending' });
      expect(engine.inspectPlayerAction(p2, 'concede')).toEqual({ kind: 'ready' });
      const cancel = { choiceId: pending.id, cancel: true };
      expect(engine.inspectPlayerAction(p1, 'choose', cancel)).toEqual({ kind: 'ready' });
      expect(engine.roomState.pendingChoice).toBe(pending);
      expect(engine.executePlayerAction(p1, 'choose', cancel).success).toBe(true);
      expect(engine.roomState.pendingChoice).toBeNull();
      expect(engine.roomState.players[p1].hand).toContainEqual(card);
      expect(engine.roomState.players[p1].mana).toEqual(room.players[p1].mana);
      expect(engine.roomState.stack).toEqual([]);
      expect(engine.inspectPlayerAction(p1, 'pass_priority')).toEqual({ kind: 'ready' });
    } finally { engine.dispose(); }
  });

  it('offers debug controls only in the configured mode and respects the open stack', () => {
    const room = createTestRoom({ debugMode: 'stack' });
    const engine = new GameEngine(room);
    try {
      expect(engine.inspectPlayerAction(p1, 'end_turn')).toEqual({ kind: 'unavailable', reason: 'Debug command is disabled in this mode' });
      expect(engine.inspectPlayerAction(p1, 'resolve_stack')).toEqual({ kind: 'unavailable', reason: 'Stack is empty' });
      const cast = { cardUuid: room.players[p1].hand[0].uuid };
      expect(engine.inspectPlayerAction(p1, 'cast_spell', cast)).toEqual({ kind: 'ready' });
      expect(engine.executePlayerAction(p1, 'cast_spell', cast).success).toBe(true);
      expect(discoverPlayerControls(engine.roomState, p1).actions).toContain('resolve_stack');
      expect(engine.inspectPlayerAction(p1, 'resolve_stack')).toEqual({ kind: 'ready' });
      expect(engine.executePlayerAction(p1, 'resolve_stack').success).toBe(true);
      expect(engine.roomState.battlefield.map(card => card.uuid)).toContain(cast.cardUuid);
      expect(discoverPlayerControls(engine.roomState, p1).actions).not.toContain('resolve_stack');
    } finally { engine.dispose(); }
  });

  it('offers the next step after an answer to a real action choice', () => {
    const room = createTestRoom();
    const card = room.players[p1].hand[0];
    card.blueprint = parseCardDefinition({
      schemaVersion: 1, id: 'allocate', cardTypes: ['Spell'],
      onCastEffects: [{
        action: 'DEAL_DAMAGE', params: { amount: 3 },
        targeting: { type: 'player', controller: 'opponent', required: true },
        choice: { kind: 'distribution', total: 3 },
      }],
    });
    const engine = new GameEngine(room);
    expect(engine.executePlayerAction(p1, 'cast_spell', { cardUuid: card.uuid }).success).toBe(true);
    const target = engine.roomState.pendingChoice!;
    if (target.kind !== 'targets') throw new Error('Expected target choice');
    const selection = { choiceId: target.id, choices: [target.options[0].id] };
    expect(engine.inspectPlayerAction(p1, 'choose', selection)).toMatchObject({
      kind: 'input', choice: { kind: 'distribution', total: 3, minimumPerOption: 1 },
    });
    expect(engine.roomState.pendingChoice).toBe(target);
    expect(engine.executePlayerAction(p1, 'choose', selection).success).toBe(true);
    const distribute = engine.roomState.pendingChoice!;
    if (distribute.kind !== 'distribution') throw new Error('Expected damage allocation');
    const allocations = { [distribute.options[0].id]: 3 };
    expect(engine.inspectPlayerAction(p1, 'choose', { choiceId: distribute.id, allocations })).toEqual({ kind: 'ready' });
    expect(engine.executePlayerAction(p1, 'choose', { choiceId: distribute.id, allocations }).success).toBe(true);
    expect(engine.roomState.stack).toHaveLength(1);
  });

  it('keeps candidates for group constraints and checks the whole combat declaration', () => {
    const first = creature('first', p1), second = creature('second', p1), tapped = creature('tapped', p1);
    tapped.state.isTapped = true;
    const room = createTestRoom({
      phase: 'declareAttackersStep', priorityPlayerId: null, battlefield: [first, second, tapped],
    });
    const engine = new GameEngine(room);
    const unregister = CombatRuleRegistry.register({
      validateAttackers: ({ attackers }) => attackers.length === 1 ? 'These creatures must attack together' : undefined,
    });
    try {
      const controls = discoverPlayerControls(room, p1);
      expect(controls.combat).toEqual({ actionId: 'declare_attackers', attackerUuids: [first.uuid, second.uuid] });
      expect(controls.actions).not.toContain('pass_priority');
      expect(discoverPlayerControls(room, p2).combat).toBeUndefined();
      const one = { attackers: [{ cardUuid: first.uuid }] };
      expect(engine.inspectPlayerAction(p1, 'declare_attackers', one)).toEqual({
        kind: 'unavailable', reason: 'These creatures must attack together',
      });
      const both = { attackers: [first, second].map(card => ({ cardUuid: card.uuid })) };
      expect(engine.inspectPlayerAction(p1, 'declare_attackers', both)).toEqual({ kind: 'ready' });
      expect(engine.executePlayerAction(p1, 'declare_attackers', both).success).toBe(true);
      expect(engine.roomState.combat.map(declaration => declaration.uuid)).toEqual([first.uuid, second.uuid]);
    } finally { unregister(); }
  });

  it('offers blocker inputs only to the defender and checks a complete flying assignment', () => {
    const attacker = creature('flyer', p1, 3, 3, ['Flying']);
    const walker = creature('walker', p2), flyer = creature('other-flyer', p2, 2, 2, ['Flying']);
    const room = createTestRoom({
      phase: 'declareBlockersStep', priorityPlayerId: null, battlefield: [attacker, walker, flyer],
      combatDeclarations: { attackers: true, blockers: false },
      combat: [{ uuid: attacker.uuid, attacker, attackerPower: 3, blockers: [] }],
    });
    const engine = new GameEngine(room);
    expect(engine.inspectPlayerAction(p1, 'declare_blockers')).toMatchObject({ kind: 'unavailable' });
    expect(engine.inspectPlayerAction(p2, 'declare_blockers')).toEqual({
      kind: 'combat', declaration: {
        actionId: 'declare_blockers', attackerUuids: [attacker.uuid], blockerUuids: [walker.uuid, flyer.uuid],
      },
    });
    const assign = (cardUuid: string) => ({ assignments: [{ attackerUuid: attacker.uuid, blockerUuids: [cardUuid] }] });
    expect(engine.inspectPlayerAction(p2, 'declare_blockers', assign(walker.uuid))).toMatchObject({ kind: 'unavailable' });
    expect(engine.inspectPlayerAction(p2, 'declare_blockers', assign(flyer.uuid))).toEqual({ kind: 'ready' });
    expect(engine.executePlayerAction(p2, 'declare_blockers', assign(flyer.uuid)).success).toBe(true);
    expect(engine.roomState.combat[0].blockers.map(blocker => blocker.uuid)).toEqual([flyer.uuid]);
  });
});
