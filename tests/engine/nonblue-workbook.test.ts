import { afterEach, describe, expect, it } from 'vitest';
import { GameEngine } from '@engine/game-engine';
import { planDamage } from '@engine/damage-service';
import { targetPermissionsAllow } from '@rules/target-legality';
import { captureSourceInformation } from '@engine/source-information';
import { StateMachine } from '@engine/state-machine';
import { CardCharacteristicService } from '@engine/card-characteristic-service';
import { getBlueprint, instantiateCard } from '@library/card-factory';
import { buildCardView } from '@server/projection/card-view';
import { buildChoiceView } from '@server/projection/choice-view';
import type { CardInstance, CardZone } from '@shared/card.types';
import { answerSingleRecipientCombat, creature } from '../helpers/combat-fixture';
import { createTestRoom, fillTestLibraries } from '../helpers/test-room-factory';

const engines: GameEngine[] = [];
afterEach(() => engines.splice(0).forEach(engine => engine.dispose()));

function card(id: string, zone: CardZone, playerId = 'player1') {
  const value = instantiateCard(id);
  value.state = { ...value.state, ownerId: playerId, controllerId: playerId, zone, summoningSickness: false };
  return value;
}
function game(...battlefield: CardInstance[]) {
  const room = createTestRoom({ battlefield });
  fillTestLibraries(room, 20);
  room.players.player1.hand = [];
  const engine = new GameEngine(room);
  engines.push(engine);
  engine.initRoom();
  return engine;
}
function cast(engine: GameEngine, value: CardInstance, modes?: string[]) {
  engine.roomState.players.player1.hand.push(value);
  return engine.executePlayerAction('player1', 'cast_spell', { cardUuid: value.uuid, modes });
}
function resolve(engine: GameEngine) {
  expect(engine.resolveTopOfStack().success).toBe(true);
}
function choose(engine: GameEngine, selections: string[]) {
  const choice = engine.roomState.pendingChoice;
  expect(choice).toBeDefined();
  expect(engine.executePlayerAction(choice!.playerId, 'choose', { choiceId: choice!.id, choices: selections }).success).toBe(true);
}
function live(engine: GameEngine, value: CardInstance) {
  return engine.roomState.battlefield.find(item => item.uuid === value.uuid)!;
}

function attackWith(engine: GameEngine, value: CardInstance) {
  live(engine, value).state.summoningSickness = false;
  engine.roomState.phase = 'declareAttackersStep';
  engine.roomState.priorityPlayerId = null;
  expect(engine.executePlayerAction('player1', 'declare_attackers', {
    attackers: [{ cardUuid: value.uuid }],
  }).success).toBe(true);
}

describe('workbook expansion beyond blue', () => {
  it.each([
    'hera-ghostfire', 'phantom-ghostaxe', 'phantom-ghostfire', 'phantom-ghostfire-scythe', 'phantasm-altar',
    'phantom-dreamer', 'wind-spirit-hornblower-murad', 'wind-spirit-beast-wrath', 'beast-emperor-command',
    'wind-spirit-beast-son', 'wind-spirit-banner-namalan', 'wind-spirit-general-haer', 'wind-emperor-leon-galar',
    'frost-messenger', 'phantom-puppet-factory', 'wind-spirit-blade-wolf', 'ice-dragon-staff', 'aralarias-end',
    'archangel-ferrani', 'angel-empress-butterfly', 'hera-camp', 'hera-phantom-spell', 'ice-dragon-call', 'phantom-puppet-sage', 'phantom-demon-hera-nia',
    'worlds-winter-emperor-kasnas',
    'wind-spirit-regrowth', 'phantom-puppet-legionnaire', 'death-assembly', 'sealed-aurora-dragon-statue',
    'aurora-shield', 'dragon-tomb', 'coldnest-lord-aleya', 'aurora-seal', 'aralarias-interception', 'icewind-guardian', 'northern-guide-lysandria', 'far-north-dragon-emperor-arthur',
    'far-north-crown', 'ice-ridge-lord', 'frostmoon-guardian', 'heavenly-divine-city', 'holy-energy-haste', 'heavenly-beast', 'heavenly-marquis-ivun', 'thunder-gate',
  ])('registers %s with a compiled ability or spell recipe', id => {
    const value = getBlueprint(id);
    expect(value.abilities.length + value.onCastEffects.length + (value.modes?.length ?? 0)).toBeGreaterThan(0);
  });

  it.each([false, true])('Frost Messenger orders the exact remainder (eligible Dragon: %s)', eligible => {
    const engine = game();
    const messenger = card('frost-messenger', 'hand');
    const outside = card('sea-depths', 'library');
    const candidate = card(eligible ? 'ice-ridge-lord' : 'sea-depths', 'library');
    const other = card('sea-patrol', 'library');
    const top = card('land-red', 'library');
    engine.roomState.players.player1.deck = [outside, other, candidate, top];
    expect(cast(engine, messenger).success).toBe(true);
    resolve(engine);
    resolve(engine);
    choose(engine, ['reveal']);
    if (eligible) choose(engine, [candidate.uuid]);

    const choice = engine.roomState.pendingChoice;
    if (choice?.kind !== 'ordering') throw new Error('Expected exact remainder ordering');
    const remainder = eligible ? [top.uuid, other.uuid] : [top.uuid, candidate.uuid, other.uuid];
    expect(choice.options.map(option => option.id)).toEqual(remainder);
    expect(choice.options.some(option => option.id === outside.uuid)).toBe(false);
    choose(engine, remainder);
    const remaining = engine.roomState.players.player1.deck.map(item => item.uuid);
    expect(remaining).toEqual(eligible
      ? [other.uuid, top.uuid, outside.uuid, candidate.uuid]
      : [other.uuid, candidate.uuid, top.uuid, outside.uuid]);
    if (eligible) {
      expect(engine.roomState.players.player1.deck.at(-1)?.state.zoneRevision ?? 0).toBe(candidate.state.zoneRevision ?? 0);
    }
    engine.applyMutations([{ type: 'DESTROY_CARD', cardUuid: messenger.uuid, zoneRevision: live(engine, messenger).state.zoneRevision ?? 0 }]);
    resolve(engine);
    expect(engine.roomState.players.player1.hand.map(item => item.uuid))
      .toEqual([eligible ? candidate.uuid : outside.uuid]);
  });

  it('Puppet Factory keeps its ordinary draw after the physical card spends the reveal option', () => {
    const engine = game();
    const factory = card('phantom-puppet-factory', 'hand');
    const outside = card('phantom-puppet', 'library');
    const puppets = ['phantom-puppet', 'phantom-ghostfire'].map(id => card(id, 'library'));
    const keep = ['sea-depths', 'land-red', 'sea-patrol'].map(id => card(id, 'library'));
    engine.roomState.players.player1.deck = [outside, ...keep, ...puppets];
    expect(cast(engine, factory).success).toBe(true);
    resolve(engine);
    resolve(engine);
    choose(engine, ['reveal-and-draw']);
    expect(engine.roomState.players.player1.graveyard.map(item => item.uuid)).toEqual(puppets.toReversed().map(item => item.uuid));
    choose(engine, keep.map(item => item.uuid));
    expect(engine.roomState.players.player1.hand.map(item => item.uuid)).toEqual([keep[0].uuid]);
    expect(engine.roomState.players.player1.deck.map(item => item.uuid)).toEqual([outside.uuid, keep[2].uuid, keep[1].uuid]);

    engine.applyMutations([
      { type: 'MOVE_CARD', cardUuid: factory.uuid, playerId: 'player1', from: 'battlefield', to: 'graveyard' },
      { type: 'MOVE_CARD', cardUuid: factory.uuid, playerId: 'player1', from: 'graveyard', to: 'battlefield' },
    ]);
    resolve(engine);
    const choice = engine.roomState.pendingChoice;
    if (choice?.kind !== 'options') throw new Error('Expected the ordinary draw option');
    expect(choice.options.map(option => option.id)).toEqual(['draw-one']);
    choose(engine, ['draw-one']);
    expect(engine.roomState.players.player1.hand.map(item => item.uuid)).toEqual([keep[0].uuid, keep[1].uuid]);
    expect(Object.values(engine.roomState.gameRuleUses ?? {})).toEqual([1]);
  });

  it('Blade Wolf deploys a land, then allows only distinct printed names from its reveal', () => {
    const engine = game();
    const wolf = card('wind-spirit-blade-wolf', 'hand');
    const land = card('beast-holy-land', 'hand');
    const duplicates = Array.from({ length: 2 }, () => card('wind-spirit-prophet', 'library'));
    const distinct = card('wind-spirit-beast-son', 'library');
    const outsiders = Array.from({ length: 3 }, () => card('sea-depths', 'library'));
    engine.roomState.players.player1.hand = [land, ...Array.from({ length: 3 }, () => card('sea-depths', 'hand'))];
    engine.roomState.players.player1.deck = [outsiders[0], ...duplicates, distinct, ...outsiders.slice(1)];
    expect(cast(engine, wolf).success).toBe(true);
    resolve(engine);
    resolve(engine);
    choose(engine, [land.uuid]);
    expect(live(engine, land).state.summonKind).toBe('effect');
    expect(engine.roomState.turnHistory?.landPlays?.player1 ?? 0).toBe(0);
    choose(engine, ['reveal']);

    const choice = engine.roomState.pendingChoice;
    if (choice?.kind !== 'search') throw new Error('Expected the distinct-name search');
    expect(choice.max).toBe(2);
    const ownView = buildChoiceView(engine.roomState, 'player1');
    expect(ownView?.kind).toBe('search');
    if (ownView?.kind !== 'search') throw new Error('Expected visible choices');
    const groups = ownView.options.map(option => option.distinctGroup);
    expect(new Set(groups).size).toBe(2);
    expect(groups.every(group => typeof group === 'string' && !group.includes('風靈'))).toBe(true);
    expect(buildChoiceView(engine.roomState, 'player2')).toEqual({ kind: 'waiting', playerId: 'player1' });
    expect(engine.executePlayerAction('player1', 'choose', {
      choiceId: choice.id, choices: duplicates.map(item => item.uuid),
    }).success).toBe(false);
    choose(engine, [duplicates[1].uuid, distinct.uuid]);
    choose(engine, [outsiders[2].uuid, duplicates[0].uuid, outsiders[1].uuid]);
    expect(engine.roomState.players.player1.hand.slice(-2).map(item => item.uuid)).toEqual([duplicates[1].uuid, distinct.uuid]);
    expect(engine.roomState.players.player1.deck.at(-1)?.uuid).toBe(outsiders[0].uuid);
  });

  it('Blade Wolf can reveal without a land and limits only that option for the turn', () => {
    const engine = game();
    const wolf = card('wind-spirit-blade-wolf', 'hand');
    engine.roomState.players.player1.deck = Array.from({ length: 5 }, () => card('sea-depths', 'library'));
    expect(cast(engine, wolf).success).toBe(true);
    resolve(engine);
    resolve(engine);
    choose(engine, []);
    choose(engine, ['reveal']);
    const ordering = engine.roomState.pendingChoice;
    if (ordering?.kind !== 'ordering') throw new Error('Expected ordering of the five revealed cards');
    choose(engine, ordering.options.map(option => option.id));
    const land = card('beast-holy-land', 'hand');
    engine.roomState.players.player1.hand = [land];
    engine.applyMutations([
      { type: 'MOVE_CARD', cardUuid: wolf.uuid, playerId: 'player1', from: 'battlefield', to: 'graveyard' },
      { type: 'MOVE_CARD', cardUuid: wolf.uuid, playerId: 'player1', from: 'graveyard', to: 'battlefield' },
    ]);
    resolve(engine);
    choose(engine, [land.uuid]);
    const choice = engine.roomState.pendingChoice;
    if (choice?.kind !== 'options') throw new Error('Expected a reveal-or-skip choice');
    expect(choice.options.map(option => option.id)).toEqual(['skip']);
    choose(engine, ['skip']);
    expect(live(engine, land).state.zone).toBe('battlefield');
  });

  it('Ice Dragon Staff grants attack and pays from its current equipped Dragon only', () => {
    const staff = card('ice-dragon-staff', 'battlefield');
    const first = card('frost-messenger', 'battlefield');
    const second = card('frost-messenger', 'battlefield');
    const enemy = card('sea-patrol', 'battlefield', 'player2');
    const engine = game(staff, first, second, enemy);
    const activate = (abilityId: string, target: CardInstance) => engine.executePlayerAction('player1', 'activate_ability', {
      cardUuid: staff.uuid, abilityId, targets: [{ targetType: 'permanent', cardUuid: target.uuid }],
    });
    const addCrystals = (target: CardInstance, amount: number) => engine.applyMutations([
      { type: 'ADD_COUNTER', cardUuid: target.uuid, counterType: 'ice-crystal', amount },
    ]);
    addCrystals(first, 1);
    expect(activate('ice-crystal-bounce', enemy).success).toBe(false);
    expect(activate('attach', first).success).toBe(true);
    resolve(engine);
    expect(CardCharacteristicService.resolvePower(engine.roomState, live(engine, first))).toBe(2);
    attackWith(engine, first);
    resolve(engine);
    expect(live(engine, first).state.counters['ice-crystal']).toBe(2);
    expect(live(engine, staff).state.counters['ice-crystal']).toBeUndefined();

    engine.roomState.phase = 'stateMainPhase';
    engine.roomState.priorityPlayerId = 'player1';
    expect(activate('attach', second).success).toBe(true);
    resolve(engine);
    expect(activate('ice-crystal-bounce', enemy).success).toBe(false);
    addCrystals(second, 2);
    expect(activate('ice-crystal-bounce', enemy).success).toBe(true);
    expect(live(engine, second).state.counters['ice-crystal'] ?? 0).toBe(0);
    expect(live(engine, first).state.counters['ice-crystal']).toBe(2);
    resolve(engine);
    expect(engine.roomState.players.player2.hand.map(item => item.uuid)).toContain(enemy.uuid);
  });

  it('Aralaria’s End exiles a charged emperor as payment, then destroys opposing creatures and relics', () => {
    const spell = card('aralarias-end', 'hand');
    const emperor = card('angel-emperor-aralaria', 'battlefield');
    const low = card('angel-emperor-aralaria', 'battlefield');
    const opposing = card('angel-emperor-aralaria', 'battlefield', 'player2');
    const creature = card('sea-patrol', 'battlefield', 'player2');
    const relic = card('flame-ballista', 'battlefield', 'player2');
    const equipment = card('ice-dragon-staff', 'battlefield', 'player2');
    emperor.state.counters.charge = 5;
    low.state.counters.charge = 4;
    opposing.state.counters.charge = 8;
    const engine = game(emperor, low, opposing, creature, relic, equipment);
    expect(cast(engine, spell).success).toBe(true);
    const choice = engine.roomState.pendingChoice;
    if (choice?.kind !== 'selection') throw new Error('Expected exile materials');
    expect(choice.options.map(option => option.id)).toEqual([emperor.uuid]);
    expect(engine.roomState.players.player1.mana.yellow).toBe(5);
    choose(engine, [emperor.uuid]);
    expect(engine.roomState.players.player1.exile?.map(value => value.uuid)).toEqual([emperor.uuid]);
    expect(engine.roomState.players.player1.mana.yellow).toBe(1);
    expect(Object.values(engine.roomState.gameRuleUses ?? {})).toEqual([1]);
    resolve(engine);
    expect(engine.roomState.players.player2.graveyard.map(value => value.uuid).sort())
      .toEqual([creature.uuid, relic.uuid].sort());
    expect(live(engine, equipment)).toBeDefined();
    expect(live(engine, opposing)).toBeDefined();
    expect(live(engine, low)).toBeDefined();

    live(engine, low).state.counters.charge = 5;
    engine.roomState.players.player1.mana.yellow = 5;
    engine.applyMutations([{ type: 'MOVE_CARD', cardUuid: spell.uuid, playerId: 'player1', from: 'graveyard', to: 'hand' }]);
    expect(engine.executePlayerAction('player1', 'cast_spell', { cardUuid: spell.uuid }).success).toBe(false);
    expect(live(engine, low)).toBeDefined();
    expect(engine.roomState.players.player1.mana.yellow).toBe(5);
  });

  it.each(['cancel_event', 'move_destination'] as const)('Aralaria’s End pays nothing when the emperor’s exile is replaced by %s', replacement => {
    const spell = card('aralarias-end', 'hand');
    const emperor = card('angel-emperor-aralaria', 'battlefield');
    emperor.state.counters.charge = 5;
    const engine = game(emperor);
    engine.roomState.replacementEffects = [{
      id: 'exile-replacement', label: 'Replace exile', uses: 1,
      match: { kinds: ['zone_transfer'], to: 'exile' },
      operation: replacement === 'cancel_event' ? { type: replacement } : { type: replacement, to: 'hand' },
    }];
    engine.roomState.players.player1.hand = [spell];
    const castWith = (zoneRevision: number) => engine.executePlayerAction('player1', 'cast_spell', {
      cardUuid: spell.uuid, materialPayments: [{ cardUuid: emperor.uuid, zoneRevision }],
    });
    expect(castWith(1).success).toBe(false);
    const input = { cardUuid: spell.uuid, materialPayments: [{ cardUuid: emperor.uuid, zoneRevision: 0 }] };
    expect(engine.inspectPlayerAction('player1', 'cast_spell', input).kind).toBe('unavailable');
    expect(castWith(0).success).toBe(false);
    expect(engine.roomState.players.player1.mana.yellow).toBe(5);
    expect(engine.roomState.players.player1.hand.map(value => value.uuid)).toEqual([spell.uuid]);
    expect(engine.roomState.stack).toHaveLength(0);
    expect(Object.values(engine.roomState.gameRuleUses ?? {})).toEqual([]);
    expect(live(engine, emperor).state.counters.charge).toBe(5);
    expect(engine.roomState.replacementEffects[0].uses).toBe(1);
  });

  it.each([false, true])('Butterfly heals after its actual hand discard (discard replaced: %s)', replaced => {
    const butterfly = card('angel-empress-butterfly', 'hand');
    const engine = game();
    engine.roomState.players.player1.hand = [butterfly];
    if (replaced) engine.roomState.replacementEffects = [{
      id: 'prevent-discard', label: 'Prevent discard', match: { kinds: ['discard'], from: 'hand' },
      operation: { type: 'cancel_event' },
    }];
    engine.applyMutations([{ type: 'SET_LIFE', playerId: 'player1', amount: 17 }]);
    resolve(engine);
    expect(engine.roomState.players.player1.life).toBe(replaced ? 17 : 22);
    expect(engine.roomState.players.player1.graveyard.map(value => value.uuid))
      .toEqual(replaced ? [] : [butterfly.uuid]);
  });

  it('Butterfly boosts allied healing without modifying a direct life setting', () => {
    const butterfly = card('angel-empress-butterfly', 'battlefield');
    const engine = game(butterfly);
    expect(cast(engine, card('holy-energy-haste', 'hand'), ['heal']).success).toBe(true);
    resolve(engine);
    expect(engine.roomState.players.player1.life).toBe(23);
    expect(cast(engine, card('archangel-ferrani', 'hand')).success).toBe(true);
    resolve(engine);
    resolve(engine);
    expect(engine.roomState.players.player1.life).toBe(30);
  });

  it.each(['player', 'damage', 'max-life'] as const)('Hera’s Camp shares one draw budget starting from %s', first => {
    const camp = card('hera-camp', 'battlefield');
    const target = card('abyss-giant', 'battlefield', 'player2');
    const engine = game(camp, target);
    const changes = {
      player: () => engine.applyMutations([{ type: 'SET_LIFE', playerId: 'player2', amount: 19 }]),
      damage: () => engine.applyMutations(planDamage(engine.roomState, [{
        source: captureSourceInformation(engine.roomState, camp),
        recipient: { kind: 'permanent', cardUuid: target.uuid, zoneRevision: 0 },
        amount: 1, combat: false,
      }])),
      'max-life': () => engine.applyMutations([{ type: 'ADD_CONTINUOUS_EFFECT', entry: {
        source: 'fixture', layer: 7, scope: { cardUuid: target.uuid }, requiredZone: null, duration: 'PERMANENT',
        effect: { type: 'STAT_DELTA', toughness: -1 },
      } }]),
    };
    changes[first]();
    expect(engine.roomState.stack).toHaveLength(1);
    for (const [type, apply] of Object.entries(changes)) if (type !== first) apply();
    expect(engine.roomState.stack).toHaveLength(1);
    resolve(engine);
    expect(engine.roomState.players.player1.hand).toHaveLength(1);
    expect(engine.executePlayerAction('player1', 'activate_ability', {
      cardUuid: camp.uuid, abilityId: 'tap-to-draw',
    }).success).toBe(true);
    resolve(engine);
    expect(engine.roomState.players.player1.hand).toHaveLength(2);
    engine.applyMutations([{ type: 'SET_TURN', playerId: 'player1', advance: true }]);
    engine.applyMutations([{ type: 'SET_LIFE', playerId: 'player2', amount: 18 }]);
    expect(engine.roomState.stack.at(-1)?.source.uuid).toBe(camp.uuid);
    resolve(engine);
    expect(engine.roomState.players.player1.hand).toHaveLength(3);
  });

  it.each([
    { phase: 'stateMainPhase', turnPlayer: 'player1', graveyardCost: 4, ownMain: true },
    { phase: 'beginCombatStep', turnPlayer: 'player1', graveyardCost: 0, ownMain: false },
    { phase: 'stateMainPhase', turnPlayer: 'player2', graveyardCost: 4, ownMain: false },
  ] as const)('Hera’s Phantom Spell uses printed costs in $phase on $turnPlayer’s turn', ({ phase, turnPlayer, graveyardCost, ownMain }) => {
    const engine = game(...Array.from({ length: 5 }, () => card('phantom-land-soldier', 'battlefield')));
    const low = card('phantom-puppet', 'graveyard');
    const medium = card('phantom-puppet-legionnaire', 'graveyard');
    const giant = card('phantom-giant', 'graveyard');
    engine.roomState.players.player1.graveyard = [low, medium, giant];
    engine.roomState.phase = phase;
    engine.roomState.activeTurnPlayerId = turnPlayer;
    expect(CardCharacteristicService.resolveManaValue(engine.roomState, giant)).toBe(graveyardCost);
    expect(cast(engine, card('hera-phantom-spell', 'hand')).success).toBe(true);
    resolve(engine);
    const choice = engine.roomState.pendingChoice;
    if (choice?.kind !== 'search') throw new Error('Expected the Puppet search');
    expect(choice.options.map(option => option.id)).toEqual(ownMain ? [low.uuid, medium.uuid] : [low.uuid]);
    const chosen = ownMain ? medium : low;
    choose(engine, [chosen.uuid]);
    expect(live(engine, chosen).state.summonKind).toBe('effect');
  });

  it.each([['none', []], ['opponent only', ['player2']], ['friendly', ['player1']], ['two friendly', ['player1', 'player1']]])
  ('Ice Dragon Call reads a fresh window for at most one repeat (%s)', (_scenario, controllers) => {
    const repeat = controllers.includes('player1');
    const engine = game(...controllers.map(controller => card('ice-ridge-lord', 'battlefield', controller)));
    const [first, second] = ['ice-ridge-lord', 'frost-messenger'].map(id => card(id, 'library'));
    const [deep, spare, firstTop, firstBottom] = Array.from({ length: 4 }, () => card('sea-depths', 'library'));
    engine.roomState.players.player1.deck = [deep, second, spare, firstBottom, first, firstTop];
    const spell = card('ice-dragon-call', 'hand');
    expect(spell.blueprint.rulesText).toContain('若我方場上有「冰龍」僕從，再執行此效果一次。');
    expect(cast(engine, spell).success).toBe(true);
    resolve(engine);
    choose(engine, [first.uuid]);
    choose(engine, [firstTop.uuid, firstBottom.uuid]);
    if (repeat) {
      choose(engine, [second.uuid]);
      choose(engine, [spare.uuid, deep.uuid]);
    }
    expect(engine.roomState.pendingChoice).toBeFalsy();
    expect(engine.roomState.players.player1.hand.map(value => value.uuid))
      .toEqual(repeat ? [first.uuid, second.uuid] : [first.uuid]);
    const reveals = engine.drainEventBatches().flatMap(batch => batch.events).filter(event => event.eventId === 'CARD_REVEALED');
    expect(reveals).toHaveLength(repeat ? 6 : 3);
  });

  it('Puppet Sage counts three allies and applies its attack bonus only once across copies', () => {
    const first = card('phantom-puppet-sage', 'battlefield');
    const second = card('phantom-puppet-sage', 'battlefield');
    const puppet = card('phantom-puppet', 'battlefield');
    const ally = card('phantom-puppet', 'battlefield');
    const enemy = card('phantom-puppet', 'battlefield', 'player2');
    const engine = game(first, second, puppet, ally, enemy);
    const power = (value: CardInstance) => CardCharacteristicService.resolvePower(engine.roomState, live(engine, value));
    const remove = (value: CardInstance) => engine.applyMutations([
      { type: 'MOVE_CARD', cardUuid: value.uuid, playerId: 'player1', from: 'battlefield', to: 'graveyard' },
    ]);
    expect(power(puppet)).toBe(2);
    engine.applyMutations([{ type: 'SET_PHASE', phase: 'beginCombatStep' }]);
    expect(power(puppet)).toBe(3);
    expect(power(first)).toBe(6);
    expect(power(enemy)).toBe(2);
    remove(first);
    expect(power(puppet)).toBe(3);
    const graveSage = engine.roomState.players.player1.graveyard.find(value => value.uuid === first.uuid)!;
    expect(CardCharacteristicService.resolveManaValue(engine.roomState, graveSage)).toBe(3);
    remove(ally);
    expect(power(puppet)).toBe(2);
    expect(CardCharacteristicService.resolveManaValue(engine.roomState, live(engine, second))).toBe(6);
  });

  it.each([4, 9])('Aurora Shield caps combined life loss from simultaneous damage (starting life %s)', startingLife => {
    const attacker = card('abyss-giant', 'battlefield', 'player2');
    const engine = game(attacker);
    engine.applyMutations([{ type: 'SET_LIFE', playerId: 'player1', amount: startingLife }]);
    expect(cast(engine, card('aurora-shield', 'hand')).success).toBe(true);
    resolve(engine);
    const source = captureSourceInformation(engine.roomState, attacker);
    engine.applyMutations(planDamage(engine.roomState, [1, 2, 3].map(() => ({
      source, recipient: { kind: 'player', playerId: 'player1' }, amount: 3, combat: true,
    }))));
    const protectedLife = Math.min(startingLife, 5);
    expect(engine.roomState.players.player1.life).toBe(protectedLife);
    engine.applyMutations([{ type: 'SET_LIFE', playerId: 'player1', amount: 1 }]);
    expect(engine.roomState.players.player1.life).toBe(protectedLife);
    engine.applyMutations([{ type: 'CLEAR_END_OF_TURN_EFFECTS' }, { type: 'CHANGE_LIFE', playerId: 'player1', amount: -1 }]);
    expect(engine.roomState.players.player1.life).toBe(protectedLife - 1);
  });

  it('Aleya protects both players through end-of-combat responses and charges on friendly Dragon entries', () => {
    const aleya = card('coldnest-lord-aleya', 'battlefield');
    aleya.state.counters.charge = 3;
    const engine = game(aleya);
    const friendly = card('ice-ridge-lord', 'hand');
    const opposing = card('ice-ridge-lord', 'hand', 'player2');
    engine.roomState.players.player1.hand = [friendly];
    engine.roomState.players.player2.hand = [opposing];
    engine.applyMutations([friendly, opposing].map(value => ({
      type: 'MOVE_CARD', cardUuid: value.uuid, playerId: value.state.ownerId, from: 'hand', to: 'battlefield',
    })));
    expect(engine.roomState.stack).toHaveLength(1);
    resolve(engine);
    expect(live(engine, aleya).state.counters.charge).toBe(4);
    const activate = () => engine.executePlayerAction('player1', 'activate_ability', {
      cardUuid: aleya.uuid, abilityId: 'guard-both-players',
    });
    expect(activate().success).toBe(false);
    expect(live(engine, aleya).state.counters.charge).toBe(4);

    engine.applyMutations([{ type: 'SET_PHASE', phase: 'beginCombatStep' }]);
    expect(activate().success).toBe(true);
    resolve(engine);
    expect(live(engine, aleya).state.counters.charge ?? 0).toBe(0);
    const loss = ['player1', 'player2'].map(playerId => ({ type: 'CHANGE_LIFE' as const, playerId, amount: -2 }));
    engine.applyMutations([{ type: 'SET_PHASE', phase: 'endCombatStep' }, ...loss]);
    expect(Object.values(engine.roomState.players).map(player => player.life)).toEqual([20, 20]);
    const state = new StateMachine(engine.roomState);
    engine.applyMutations(state.transition(engine.roomState, 'postcombatMainPhase'));
    engine.applyMutations(loss);
    expect(Object.values(engine.roomState.players).map(player => player.life)).toEqual([18, 18]);
  });

  it.each([false, true])('Aurora Seal follows the exact source incarnation (left and returned: %s)', returned => {
    const creature = card('card_09876_core_set', 'battlefield', 'player2');
    const engine = game(creature);
    engine.roomState.priorityPlayerId = 'player2';
    expect(engine.executePlayerAction('player2', 'activate_ability', {
      cardUuid: creature.uuid, abilityId: 'firebreathing',
    }).success).toBe(true);
    const pending = engine.roomState.stack[0].uuid;
    if (returned) engine.applyMutations([
      { type: 'MOVE_CARD', cardUuid: creature.uuid, playerId: 'player2', from: 'battlefield', to: 'exile' },
      { type: 'MOVE_CARD', cardUuid: creature.uuid, playerId: 'player2', from: 'exile', to: 'battlefield' },
    ]);
    engine.passPriority('player2');
    const seal = card('aurora-seal', 'hand');
    engine.roomState.players.player1.hand = [seal];
    expect(engine.executePlayerAction('player1', 'cast_spell', {
      cardUuid: seal.uuid, targets: [{ targetType: 'stack', stackUuid: pending }],
    }).success).toBe(true);
    resolve(engine);
    expect(engine.roomState.stack).toHaveLength(0);
    expect(!!live(engine, creature)).toBe(returned);
    expect(engine.roomState.players.player2.deck[0]?.uuid === creature.uuid).toBe(!returned);
  });

  it.each(['hand', 'battlefield'] as const)('Interception removes an opposing ability and its live %s source', zone => {
    const source = card('card_09876_core_set', zone, 'player2');
    const original = source.blueprint.abilities.find(ability => ability.id === 'firebreathing');
    if (original?.type !== 'activated') throw new Error('Expected activated ability');
    source.blueprint = { ...source.blueprint, abilities: [{ ...original, allowedZones: [zone] }] };
    const engine = zone === 'battlefield' ? game(source) : game();
    if (zone === 'hand') engine.roomState.players.player2.hand = [source];
    engine.roomState.priorityPlayerId = 'player2';
    expect(engine.executePlayerAction('player2', 'activate_ability', {
      cardUuid: source.uuid, abilityId: 'firebreathing',
    }).success).toBe(true);
    const pending = engine.roomState.stack[0].uuid;
    engine.passPriority('player2');
    const interception = card('aralarias-interception', 'hand');
    engine.roomState.players.player1.hand = [interception];
    expect(engine.executePlayerAction('player1', 'cast_spell', {
      cardUuid: interception.uuid, targets: [{ targetType: 'stack', stackUuid: pending }],
    }).success).toBe(true);
    engine.drainEventBatches();
    resolve(engine);
    expect(engine.roomState.stack).toHaveLength(0);
    expect(engine.roomState.players.player2.graveyard.map(value => value.uuid)).toContain(source.uuid);
    const events = engine.drainEventBatches().flatMap(batch => batch.events);
    expect(events.some(event => event.eventId === (zone === 'hand' ? 'CARD_DISCARDED_FROM_HAND' : 'PERMANENT_DESTROYED'))).toBe(true);
  });

  it('Interception counters a pending effect without a live source card', () => {
    const engine = game();
    const source = card('card_09876_core_set', 'battlefield', 'player2');
    engine.applyMutations([{ type: 'PUSH_STACK', stackObject: {
      uuid: 'source-less-effect', type: 'triggered', source, controllerId: 'player2', effects: [], countered: false,
    } }]);
    const interception = card('aralarias-interception', 'hand');
    engine.roomState.players.player1.hand = [interception];
    expect(engine.executePlayerAction('player1', 'cast_spell', {
      cardUuid: interception.uuid, targets: [{ targetType: 'stack', stackUuid: 'source-less-effect' }],
    }).success).toBe(true);
    resolve(engine);
    expect(engine.roomState.stack).toHaveLength(0);
    expect(engine.roomState.players.player2.graveyard).toHaveLength(0);
  });

  it.each([false, true])('Icewind Guardian redirects the original target if still on the battlefield (%s leaves)', leaves => {
    const dragon = card('ice-ridge-lord', 'battlefield');
    const guardian = card('icewind-guardian', 'hand');
    const engine = game(dragon);
    expect(cast(engine, guardian).success).toBe(true);
    resolve(engine);
    resolve(engine);
    expect(live(engine, guardian).state.counters.aurora).toBe(1);

    const spell = card('fireball', 'hand', 'player2');
    engine.roomState.activeTurnPlayerId = 'player2';
    engine.roomState.priorityPlayerId = 'player2';
    engine.roomState.players.player2.hand = [spell];
    expect(engine.executePlayerAction('player2', 'cast_spell', {
      cardUuid: spell.uuid, modes: ['main-scorch'], targets: [{ targetType: 'permanent', cardUuid: dragon.uuid }],
    }).success).toBe(true);
    expect(engine.roomState.stack.map(object => object.type)).toEqual(['spell', 'triggered']);
    if (leaves) engine.applyMutations([
      { type: 'MOVE_CARD', cardUuid: guardian.uuid, playerId: 'player1', from: 'battlefield', to: 'exile' },
    ]);
    resolve(engine);
    if (!leaves) choose(engine, ['yes']);
    expect(engine.roomState.pendingChoice).toBeFalsy();
    const target = engine.roomState.stack[0].targetGroups?.[0].targets[0];
    expect(target?.cardUuid).toBe(leaves ? dragon.uuid : guardian.uuid);
    resolve(engine);
    expect(live(engine, dragon).state.counters.scorch ?? 0).toBe(leaves ? 2 : 0);
    if (!leaves) expect(live(engine, guardian).state.counters.scorch).toBe(2);
  });

  it('Lysandria can enter from hand after an Aurora-marked creature leaves and take both revealed categories', () => {
    const marked = card('ice-ridge-lord', 'battlefield');
    const unmarked = card('frost-messenger', 'battlefield');
    const guide = card('northern-guide-lysandria', 'hand');
    marked.state.counters.aurora = 1;
    const engine = game(marked, unmarked);
    engine.roomState.players.player1.hand = [guide];
    const dragon = card('icewind-guardian', 'library');
    const relic = card('flame-ballista', 'library');
    relic.blueprint = { ...relic.blueprint, colors: ['white'] };
    const equipment = card('ice-dragon-staff', 'library');
    const outside = card('frost-messenger', 'library');
    engine.roomState.players.player1.deck = [outside, relic, equipment, dragon];
    const exile = (value: CardInstance) => engine.applyMutations([
      { type: 'MOVE_CARD', cardUuid: value.uuid, playerId: 'player1', from: 'battlefield', to: 'exile' },
    ]);
    exile(unmarked);
    expect(engine.roomState.stack).toHaveLength(0);
    exile(marked);
    resolve(engine);
    choose(engine, ['yes']);
    expect(live(engine, guide).state.summonKind).toBe('effect');
    resolve(engine);
    choose(engine, ['reveal']);
    choose(engine, [dragon.uuid]);
    const relicChoice = engine.roomState.pendingChoice;
    if (relicChoice?.kind !== 'search') throw new Error('Expected relic choice');
    expect(relicChoice.options.map(option => option.id)).toEqual([relic.uuid]);
    choose(engine, [relic.uuid]);
    choose(engine, [equipment.uuid]);
    expect(engine.roomState.players.player1.hand.map(value => value.uuid)).toEqual([dragon.uuid, relic.uuid]);
    expect(engine.roomState.players.player1.deck.map(value => value.uuid)).toEqual([equipment.uuid, outside.uuid]);
  });

  it('Arthur gives each friendly Ice Dragon its own target and follows actual creature damage with half rounded down', () => {
    const ally = card('frost-messenger', 'battlefield');
    const opposingDragon = card('icewind-guardian', 'battlefield', 'player2');
    const first = card('abyss-giant', 'battlefield', 'player2');
    const second = card('abyss-giant', 'battlefield', 'player2');
    const arthur = card('far-north-dragon-emperor-arthur', 'hand');
    const engine = game(ally, opposingDragon, first, second);
    engine.applyMutations([{ type: 'ADD_REPLACEMENT_EFFECT', effect: {
      label: 'Reduce one hit', match: { kinds: ['damage'], card: { cardUuid: second.uuid, zoneRevision: 0 } },
      operation: { type: 'reduce_damage', amount: 2 },
    } }]);
    expect(cast(engine, arthur).success).toBe(true);
    resolve(engine);
    const target = (value: CardInstance) => {
      const choice = engine.roomState.pendingChoice;
      if (choice?.kind !== 'targets') throw new Error('Expected a separate summon target');
      expect(choice.options).toHaveLength(3);
      const option = choice.options.find(option => (option.value as { cardUuid: string }).cardUuid === value.uuid);
      expect(option).toBeDefined();
      choose(engine, [option!.id]);
    };
    target(first);
    target(second);
    expect(engine.roomState.pendingChoice).toBeFalsy();
    expect(engine.roomState.stack.map(object => object.targetGroups?.[0].targets[0].cardUuid))
      .toEqual([first.uuid, second.uuid]);
    resolve(engine);
    expect(live(engine, second).state.damageTaken).toBe(3);
    resolve(engine);
    expect(engine.roomState.players.player2.life).toBe(19);
    expect(engine.roomState.stack).toHaveLength(1);
    resolve(engine);
    expect(live(engine, first).state.damageTaken).toBe(5);
    resolve(engine);
    expect(engine.roomState.players.player2.life).toBe(17);
    expect(engine.roomState.stack).toHaveLength(0);

    engine.applyMutations(planDamage(engine.roomState, [{
      source: captureSourceInformation(engine.roomState, live(engine, arthur)),
      recipient: { kind: 'player', playerId: 'player2' }, amount: 4, combat: false,
    }]));
    expect(engine.roomState.players.player2.life).toBe(13);
    expect(engine.roomState.stack).toHaveLength(0);
  });

  it('Hera Nia can pay to summon after an effect mills it and uses the settled mana value of its own mill', () => {
    const opponent = card('abyss-giant', 'battlefield', 'player2');
    const engine = game(opponent);
    const hera = card('phantom-demon-hera-nia', 'library');
    const sage = card('phantom-puppet-sage', 'library');
    engine.roomState.players.player1.deck.push(sage, hera);
    const before = CardCharacteristicService.resolveToughness(engine.roomState, opponent);
    expect(cast(engine, card('phantom-ghostfire', 'hand')).success).toBe(true);
    resolve(engine);
    resolve(engine);
    choose(engine, ['yes']);
    resolve(engine);
    choose(engine, ['summon']);
    choose(engine, ['yes']);
    expect(engine.roomState.players.player1.mana.black).toBe(1);
    expect(live(engine, hera).state.summonKind).toBe('effect');
    resolve(engine);
    const choice = engine.roomState.pendingChoice;
    if (choice?.kind !== 'selection') throw new Error('Expected one opposing creature');
    const option = choice.options.find(option => (option.value as { cardUuid: string }).cardUuid === opponent.uuid);
    choose(engine, [option!.id]);
    expect(engine.roomState.players.player1.graveyard.map(value => value.uuid)).toContain(sage.uuid);
    expect(CardCharacteristicService.resolveToughness(engine.roomState, live(engine, opponent))).toBe(before - 3);
    engine.applyMutations([{ type: 'CLEAR_END_OF_TURN_EFFECTS' }]);
    expect(CardCharacteristicService.resolveToughness(engine.roomState, live(engine, opponent))).toBe(before);
  });

  it('Hera Nia returns after an effect discards it from hand', () => {
    const engine = game();
    const hera = card('phantom-demon-hera-nia', 'hand');
    engine.roomState.players.player1.hand = [hera];
    expect(cast(engine, card('wind-spirit-regrowth', 'hand'), ['replace-hand']).success).toBe(true);
    resolve(engine);
    resolve(engine);
    choose(engine, ['return']);
    expect(engine.roomState.players.player1.hand.map(value => value.uuid)).toContain(hera.uuid);
  });

  it('Hera Nia stays discarded when it pays a cost during an effect', () => {
    const engine = game();
    const hera = card('phantom-demon-hera-nia', 'hand');
    const spell = card('aurora-shield', 'hand');
    spell.blueprint = { ...spell.blueprint, onCastEffects: [{
      action: 'PAY_COST', params: { cost: { discard: 1 }, then: [] },
      targeting: { type: 'self', required: false },
    }] };
    engine.roomState.players.player1.hand = [hera];
    expect(cast(engine, spell).success).toBe(true);
    resolve(engine);
    choose(engine, ['yes']);
    const choice = engine.roomState.pendingChoice;
    if (choice?.kind !== 'discard') throw new Error('Expected a discard payment');
    choose(engine, choice.options.map(option => option.id));
    expect(engine.roomState.players.player1.graveyard.map(value => value.uuid)).toContain(hera.uuid);
    expect(engine.roomState.stack).toHaveLength(0);
  });

  it('Ferrani sets life once for the physical card and rounds down his combat bonus', () => {
    const ferrani = card('archangel-ferrani', 'hand');
    const engine = game();
    expect(cast(engine, ferrani).success).toBe(true);
    resolve(engine);
    resolve(engine);
    expect(engine.roomState.players.player1.life).toBe(30);
    engine.applyMutations([{ type: 'SET_LIFE', playerId: 'player1', amount: 23 }]);
    engine.applyMutations([
      { type: 'MOVE_CARD', cardUuid: ferrani.uuid, playerId: 'player1', from: 'battlefield', to: 'graveyard' },
      { type: 'MOVE_CARD', cardUuid: ferrani.uuid, playerId: 'player1', from: 'graveyard', to: 'battlefield' },
    ]);
    expect(engine.roomState.stack).toHaveLength(0);
    expect(engine.roomState.players.player1.life).toBe(23);
    attackWith(engine, ferrani);
    resolve(engine);
    expect(CardCharacteristicService.resolvePower(engine.roomState, live(engine, ferrani))).toBe(10);
    engine.applyMutations([{ type: 'SET_LIFE', playerId: 'player1', amount: 20 }]);
    engine.applyMutations([{ type: 'SET_PHASE', phase: 'endCombatStep' }]);
    expect(CardCharacteristicService.resolvePower(engine.roomState, live(engine, ferrani))).toBe(10);
    engine.applyMutations([{ type: 'CLEAR_COMBAT' }]);
    expect(CardCharacteristicService.resolvePower(engine.roomState, live(engine, ferrani))).toBe(2);
  });

  it('Wind Spirit Regrowth replaces the hand using the opposing hand size at resolution', () => {
    const engine = game();
    const old = card('sea-depths', 'hand');
    engine.roomState.players.player1.hand = [old];
    engine.roomState.players.player2.hand = [card('sea-depths', 'hand', 'player2')];
    expect(cast(engine, card('wind-spirit-regrowth', 'hand'), ['replace-hand']).success).toBe(true);
    engine.roomState.players.player2.hand.push(card('sea-depths', 'hand', 'player2'));
    resolve(engine);
    expect(engine.roomState.players.player1.graveyard.map(item => item.uuid)).toContain(old.uuid);
    expect(engine.roomState.players.player1.hand).toHaveLength(2);
  });

  it('Wind Spirit Regrowth boosts a friendly creature only during the current combat', () => {
    const ally = card('phantom-puppet-legionnaire', 'battlefield');
    const engine = game(ally);
    engine.roomState.phase = 'beginCombatStep';
    const regrowth = card('wind-spirit-regrowth', 'hand');
    engine.roomState.players.player1.hand = [regrowth];
    expect(engine.executePlayerAction('player1', 'cast_spell', {
      cardUuid: regrowth.uuid, modes: ['combat-boost'], targets: [{ targetType: 'permanent', cardUuid: ally.uuid }],
    }).success).toBe(true);
    resolve(engine);
    expect(CardCharacteristicService.resolvePower(engine.roomState, live(engine, ally))).toBe(4);
    engine.applyMutations([{ type: 'CLEAR_COMBAT' }]);
    expect(CardCharacteristicService.resolvePower(engine.roomState, live(engine, ally))).toBe(3);
  });

  it.each([false, true])('Legionnaire gains four attack only after deploying its selected Puppet (%s)', deploy => {
    const legionnaire = card('phantom-puppet-legionnaire', 'battlefield');
    const puppet = card('phantom-puppet', 'graveyard');
    const engine = game(legionnaire);
    engine.roomState.players.player1.graveyard = [puppet, card('sea-patrol', 'graveyard')];
    attackWith(engine, legionnaire);
    resolve(engine);
    choose(engine, deploy ? [puppet.uuid] : []);
    expect(live(engine, puppet)?.state.summonKind).toBe(deploy ? 'effect' : undefined);
    expect(CardCharacteristicService.resolvePower(engine.roomState, live(engine, legionnaire))).toBe(deploy ? 7 : 3);
    engine.applyMutations([{ type: 'CLEAR_COMBAT' }]);
    expect(CardCharacteristicService.resolvePower(engine.roomState, live(engine, legionnaire))).toBe(3);
  });

  it.each([false, true])('Death Assembly requires three successful destructions (%s protected)', protect => {
    const puppets = Array.from({ length: 3 }, () => card('phantom-puppet', 'battlefield'));
    const engine = game(...puppets);
    const assembly = card('death-assembly', 'hand');
    engine.roomState.players.player1.hand = [assembly];
    expect(engine.executePlayerAction('player1', 'cast_spell', {
      cardUuid: assembly.uuid, targets: puppets.map(value => ({ targetType: 'permanent', cardUuid: value.uuid })),
    }).success).toBe(true);
    if (protect) engine.applyMutations([{ type: 'ADD_CONTINUOUS_EFFECT', entry: {
      source: 'test', requiredZone: null, scope: { cardUuid: puppets[0].uuid }, layer: 6,
      duration: 'END_OF_TURN', effect: { type: 'ABILITY', addKeywords: ['Indestructible'] },
    } }]);
    resolve(engine);
    const tokens = engine.roomState.battlefield.filter(item => item.isToken);
    expect(tokens).toHaveLength(protect ? 0 : 1);
    expect(engine.roomState.players.player1.graveyard.filter(item => item.blueprint.id === 'phantom-puppet'))
      .toHaveLength(protect ? 2 : 3);
    if (protect) return;
    const [token] = tokens;
    expect(token.blueprint).toMatchObject({ id: 'token-phantom-stitch-monster', power: 7, toughness: 6 });
    attackWith(engine, token);
    resolve(engine);
    choose(engine, [puppets[0].uuid]);
    expect(live(engine, puppets[0]).state.summonKind).toBe('effect');
  });

  it('a sealed Statue opens at three friendly Aurora placements and closes again below three', () => {
    const statue = card('sealed-aurora-dragon-statue', 'battlefield');
    const enemy = card('sea-patrol', 'battlefield', 'player2');
    const engine = game(statue, enemy);
    const flags = () => buildCardView(engine.roomState, 'player1', live(engine, statue));
    const placeAurora = (playerId: string, amount: number) => engine.applyMutations([{
      type: 'ADD_COUNTER', cardUuid: enemy.uuid, counterType: 'aurora', amount, sourceControllerId: playerId,
    }]);
    expect(flags()).toMatchObject({ canAttack: false, canBlock: false });
    placeAurora('player2', 1);
    expect(engine.roomState.stack).toHaveLength(0);
    for (const amount of [2, 1, 1]) {
      placeAurora('player1', amount);
      resolve(engine);
    }
    expect(live(engine, statue).state.counters['ice-crystal']).toBe(3);
    expect(flags()).toMatchObject({ canAttack: true, canBlock: true });
    engine.applyMutations([{ type: 'REMOVE_COUNTER', cardUuid: statue.uuid, counterType: 'ice-crystal', amount: 1 }]);
    expect(flags()).toMatchObject({ canAttack: false, canBlock: false });

    engine.roomState.phase = 'declareAttackersStep';
    engine.roomState.priorityPlayerId = null;
    expect(engine.executePlayerAction('player1', 'declare_attackers', { attackers: [{ cardUuid: statue.uuid }] }).success).toBe(false);
    engine.roomState.activeTurnPlayerId = 'player2';
    expect(engine.executePlayerAction('player2', 'declare_attackers', { attackers: [{ cardUuid: enemy.uuid }] }).success).toBe(true);
    engine.roomState.phase = 'declareBlockersStep';
    engine.roomState.priorityPlayerId = null;
    const block = () => engine.executePlayerAction('player1', 'declare_blockers', {
      assignments: [{ attackerUuid: enemy.uuid, blockerUuids: [statue.uuid] }],
    });
    expect(block().success).toBe(false);
    engine.applyMutations([{ type: 'ADD_COUNTER', cardUuid: statue.uuid, counterType: 'ice-crystal', amount: 1 }]);
    expect(block().success).toBe(true);
  });

  it('uses real source-scoped exile for Hera Ghostfire and keeps the reduction on survivors', () => {
    const victim = card('sea-patrol', 'battlefield', 'player2');
    const survivor = card('abyss-giant', 'battlefield', 'player2');
    const ally = card('sea-patrol', 'battlefield');
    const engine = game(victim, survivor, ally);
    expect(cast(engine, card('hera-ghostfire', 'hand')).success).toBe(true);
    resolve(engine);
    expect(engine.roomState.players.player2.exile?.map(item => item.uuid)).toEqual([victim.uuid]);
    engine.applyMutations([{ type: 'CLEAR_END_OF_TURN_EFFECTS' }]);
    expect(CardCharacteristicService.resolveToughness(engine.roomState, live(engine, survivor))).toBe(6);
    expect(CardCharacteristicService.resolvePower(engine.roomState, live(engine, survivor))).toBe(survivor.blueprint.power! - 2);
    expect(CardCharacteristicService.resolvePower(engine.roomState, live(engine, ally))).toBe(ally.blueprint.power);
    expect(CardCharacteristicService.resolveToughness(engine.roomState, live(engine, ally))).toBe(ally.blueprint.toughness);
  });

  it('the production Ghostfire recovers only the card it just milled', () => {
    const engine = game();
    const recent = card('hera-ghostfire', 'library');
    const older = card('hera-ghostfire', 'graveyard');
    engine.roomState.players.player1.deck.push(recent);
    engine.roomState.players.player1.graveyard.push(older);
    expect(cast(engine, card('phantom-ghostfire', 'hand')).success).toBe(true);
    resolve(engine);
    resolve(engine);
    choose(engine, ['yes']);
    const choice = engine.roomState.pendingChoice;
    if (!choice || choice.kind === 'number') throw new Error('Expected a search choice');
    expect(choice.options.map(option => option.id)).toEqual([recent.uuid]);
    choose(engine, [recent.uuid]);
    expect(engine.roomState.players.player1.hand.map(item => item.uuid)).toEqual([recent.uuid]);
  });

  it('Phantasm Altar enters tapped before any entry trigger can resolve', () => {
    const engine = game();
    const altar = card('phantasm-altar', 'hand');
    const regular = card('land-red', 'hand');
    engine.roomState.players.player1.hand.push(altar, regular);
    expect(engine.executePlayerAction('player1', 'play_land', { cardUuid: regular.uuid, zoneRevision: 0 }).success).toBe(true);
    engine.roomState.players.player1.mana.black = 1;
    expect(engine.executePlayerAction('player1', 'play_land', { cardUuid: altar.uuid, zoneRevision: 0 }).success).toBe(false);
    engine.roomState.players.player1.mana.black = 2;
    engine.drainEventBatches();
    expect(engine.executePlayerAction('player1', 'play_land', { cardUuid: altar.uuid, zoneRevision: 0 }).success).toBe(true);
    expect(engine.roomState.players.player1.mana.black).toBe(0);
    expect(engine.roomState.turnHistory?.landPlays?.player1).toBe(1);
    expect(live(engine, altar).state.isTapped).toBe(true);
    const events = engine.drainEventBatches().flatMap(batch => batch.events);
    expect(events.find(event => event.eventId === 'PERMANENT_ENTERED')?.payload.card.state.isTapped).toBe(true);
    expect(events.some(event => event.eventId === 'PERMANENT_TAPPED')).toBe(false);
    expect(engine.roomState.stack).toHaveLength(1);
  });

  it('offers Phantom Dreamer after the turn draw, and pays life for a separate draw', () => {
    const dreamer = card('phantom-dreamer', 'battlefield');
    const engine = game(dreamer);
    engine.roomState.phase = 'upkeepStep';
    engine.roomState.turnNumber = 2;
    const step = new StateMachine(engine.roomState).transition(engine.roomState, 'stateDrawPhase');
    engine.applyMutations(step);
    expect(engine.roomState.players.player1.hand).toHaveLength(1);
    expect(engine.roomState.stack[0]?.source.uuid).toBe(dreamer.uuid);
    resolve(engine);
    choose(engine, ['yes']);
    expect(engine.roomState.players.player1.life).toBe(18);
    expect(engine.roomState.players.player1.hand).toHaveLength(2);
  });

  it('draws from the bottom through the sorcery mode and keeps the top card in place', () => {
    const engine = game();
    const bottom = engine.roomState.players.player1.deck[0].uuid;
    const top = engine.roomState.players.player1.deck.at(-1)!.uuid;
    expect(cast(engine, card('holy-energy-haste', 'hand'), ['bottom-draw']).success).toBe(true);
    resolve(engine);
    expect(engine.roomState.players.player1.hand.map(item => item.uuid)).toEqual([bottom]);
    expect(engine.roomState.players.player1.deck.at(-1)?.uuid).toBe(top);
  });

  it('Ivun takes all revealed spells once, including after the same card returns', () => {
    const engine = game();
    const outside = card('sea-depths', 'library');
    const spells = Array.from({ length: 3 }, () => card('sea-depths', 'library'));
    const lands = Array.from({ length: 5 }, () => card('sea-domain', 'library'));
    engine.roomState.players.player1.deck = [outside, ...spells, ...lands];
    const ivun = card('heavenly-marquis-ivun', 'hand');
    expect(cast(engine, ivun).success).toBe(true);
    resolve(engine);
    resolve(engine);
    expect(new Set(engine.roomState.players.player1.hand.map(item => item.uuid))).toEqual(new Set(spells.map(item => item.uuid)));
    expect(new Set(engine.roomState.players.player1.exile?.map(item => item.uuid))).toEqual(new Set(lands.map(item => item.uuid)));
    expect(engine.roomState.players.player1.deck.map(item => item.uuid)).toEqual([outside.uuid]);
    engine.applyMutations([{ type: 'MOVE_CARD', cardUuid: ivun.uuid, playerId: 'player1', from: 'battlefield', to: 'hand' }]);
    engine.applyMutations([{ type: 'MOVE_CARD', cardUuid: ivun.uuid, playerId: 'player1', from: 'hand', to: 'battlefield' }]);
    expect(live(engine, ivun).state.summonKind).toBe('effect');
    expect(engine.roomState.stack).toEqual([]);
  });

  it('healing triggers Thunder Gate once and creates a vanilla 上使', () => {
    const gate = card('thunder-gate', 'battlefield');
    const engine = game(gate);
    expect(engine.executePlayerAction('player1', 'tapForMana', { cardUuid: gate.uuid, abilityId: 'produce-yellow' }).success).toBe(true);
    expect(engine.roomState.players.player1.mana.yellow).toBe(6);
    expect(live(engine, gate).state.isTapped).toBe(true);
    engine.applyMutations([{ type: 'SET_LIFE', playerId: 'player1', amount: 21 }]);
    resolve(engine);
    const tokens = () => engine.roomState.battlefield.filter(value => value.isToken);
    expect(tokens()).toHaveLength(1);
    expect(tokens()[0].blueprint).toMatchObject({ power: 1, toughness: 1, subTypes: ['上使'], abilities: [] });
    engine.applyMutations([{ type: 'MOVE_CARD', cardUuid: gate.uuid, playerId: 'player1', from: 'battlefield', to: 'hand' }]);
    engine.applyMutations([{ type: 'MOVE_CARD', cardUuid: gate.uuid, playerId: 'player1', from: 'hand', to: 'battlefield' }]);
    expect(live(engine, gate).state.isTapped).toBe(false);
    engine.applyMutations([{ type: 'SET_LIFE', playerId: 'player1', amount: 22 }]);
    expect(engine.roomState.stack).toHaveLength(0);
    expect(tokens()).toHaveLength(1);
  });

  it('a named reveal watcher can recover its exact card from the bottom', () => {
    const engine = game();
    const wrath = card('wind-spirit-beast-wrath', 'library');
    const lands = Array.from({ length: 4 }, () => card('sea-domain', 'library'));
    engine.roomState.players.player1.deck = [wrath, ...lands];
    expect(cast(engine, card('wind-spirit-hornblower-murad', 'hand')).success).toBe(true);
    resolve(engine);
    resolve(engine);
    choose(engine, []);
    choose(engine, [wrath.uuid, ...lands.map(item => item.uuid)]);
    resolve(engine);
    choose(engine, ['yes']);
    expect(engine.roomState.players.player1.hand.map(item => item.uuid)).toEqual([wrath.uuid]);
  });

  it('skips only one natural untap and allows other untap effects', () => {
    const target = card('sea-patrol', 'battlefield', 'player2');
    const engine = game(target);
    engine.applyMutations([{ type: 'TAP_CARD', cardUuid: target.uuid, skipNextUntap: true }]);
    engine.applyMutations([{ type: 'UNTAP_CARD', cardUuid: target.uuid }]);
    expect(live(engine, target).state).toMatchObject({ isTapped: false, skipNextUntap: true });
    engine.applyMutations([{ type: 'TAP_CARD', cardUuid: target.uuid }]);
    engine.roomState.phase = 'cleanupStep';
    engine.roomState.activeTurnPlayerId = 'player2';
    engine.applyMutations(new StateMachine(engine.roomState).transition(engine.roomState, 'stateTurnStart'));
    expect(live(engine, target).state).toMatchObject({ isTapped: true, skipNextUntap: false });
    engine.roomState.phase = 'cleanupStep';
    engine.applyMutations(new StateMachine(engine.roomState).transition(engine.roomState, 'stateTurnStart'));
    expect(live(engine, target).state.isTapped).toBe(false);
  });

  it('Dragon Tomb marks two friendly Dragons and recovers from overkill at zero life', () => {
    const first = card('aurora-ice-dragon', 'battlefield');
    const second = card('aurora-ice-dragon', 'battlefield');
    const unmarked = card('icewind-guardian', 'battlefield');
    const enemy = card('aurora-ice-dragon', 'battlefield', 'player2');
    const relic = card('dragon-tomb', 'hand');
    const engine = game(first, second, unmarked, enemy);

    expect(cast(engine, relic).success).toBe(true);
    resolve(engine);
    resolve(engine);
    const selection = engine.roomState.pendingChoice;
    if (selection?.kind !== 'selection') throw new Error('Expected two Ice Dragons');
    expect(selection.options.map(option => (option.value as { cardUuid: string }).cardUuid))
      .toEqual([first.uuid, second.uuid, unmarked.uuid]);
    expect([selection.min, selection.max]).toEqual([2, 2]);
    choose(engine, selection.options.slice(0, 2).map(option => option.id));
    expect([first, second, unmarked, enemy].map(card => live(engine, card).state.counters.aurora ?? 0))
      .toEqual([1, 1, 0, 0]);

    engine.applyMutations(planDamage(engine.roomState, [{
      source: captureSourceInformation(engine.roomState, enemy),
      recipient: { kind: 'permanent', cardUuid: first.uuid, zoneRevision: 0 },
      amount: 8, combat: false, preventable: false,
    }]));
    const recovery = engine.roomState.pendingChoice;
    if (recovery?.kind !== 'options') throw new Error('Expected Tomb rescue');
    const rescue = recovery.options.find(option => option.id.endsWith(':rescue') && !option.id.startsWith('skip:'));
    expect(rescue).toBeDefined();
    choose(engine, [rescue!.id]);

    const survivor = live(engine, first);
    expect(CardCharacteristicService.resolve(engine.roomState, survivor).toughness - survivor.state.damageTaken).toBe(3);
    expect(survivor.state.counters.aurora).toBe(1);
    expect(engine.roomState.players.player1.graveyard.map(card => card.uuid)).toEqual([relic.uuid]);
  });

  it('Kasnas protects friendly Yuer from opposing Spell and Creature sources, including a sweep', () => {
    const kasnas = card('worlds-winter-emperor-kasnas', 'battlefield');
    const ally = card('worlds-sea-lord', 'battlefield');
    const other = card('far-north-dragon-emperor-arthur', 'battlefield');
    const enemy = card('sea-patrol', 'battlefield', 'player2');
    const spell = card('hera-ghostfire', 'hand', 'player2');
    const relic = card('heavenly-gate', 'battlefield', 'player2');
    const engine = game(kasnas, ally, other, enemy, relic);
    const target = { targetType: 'permanent' as const, cardUuid: ally.uuid };
    expect(targetPermissionsAllow(engine.roomState, 'player2', spell, target)).toBe(false);
    expect(targetPermissionsAllow(engine.roomState, 'player2', enemy, target)).toBe(false);
    expect(targetPermissionsAllow(engine.roomState, 'player2', relic, target)).toBe(true);
    expect(targetPermissionsAllow(engine.roomState, 'player1', kasnas, target)).toBe(true);

    engine.roomState.priorityPlayerId = 'player2';
    engine.roomState.players.player2.hand = [spell];
    expect(engine.executePlayerAction('player2', 'cast_spell', { cardUuid: spell.uuid }).success).toBe(true);
    resolve(engine);
    expect(CardCharacteristicService.resolve(engine.roomState, live(engine, kasnas)).toughness).toBe(6);
    expect(CardCharacteristicService.resolve(engine.roomState, live(engine, ally)).toughness).toBe(ally.blueprint.toughness);
    expect(CardCharacteristicService.resolve(engine.roomState, live(engine, other)).toughness).toBe(3);
  });

  it('Kasnas ignores untargeted effect damage and hostile passive modifiers but still takes combat damage', () => {
    const kasnas = card('worlds-winter-emperor-kasnas', 'battlefield');
    const other = card('far-north-dragon-emperor-arthur', 'battlefield');
    const enemy = card('sea-patrol', 'battlefield', 'player2');
    const relic = card('heavenly-gate', 'battlefield', 'player2');
    const engine = game(kasnas, other, enemy, relic);
    const source = captureSourceInformation(engine.roomState, enemy);
    engine.applyMutations(planDamage(engine.roomState, [
      { source, recipient: { kind: 'permanent', cardUuid: kasnas.uuid, zoneRevision: 0 }, amount: 3, combat: false },
      { source, recipient: { kind: 'permanent', cardUuid: other.uuid, zoneRevision: 0 }, amount: 1, combat: false },
      { source, recipient: { kind: 'permanent', cardUuid: kasnas.uuid, zoneRevision: 0 }, amount: 1, combat: true },
      { source: captureSourceInformation(engine.roomState, relic),
        recipient: { kind: 'permanent', cardUuid: kasnas.uuid, zoneRevision: 0 }, amount: 1, combat: false },
    ]));
    expect(live(engine, kasnas).state.damageTaken).toBe(2);
    expect(live(engine, other).state.damageTaken).toBe(1);
    engine.applyMutations([{
      type: 'ADD_CONTINUOUS_EFFECT',
      entry: {
        source: enemy.uuid, origin: 'static', layer: 6, duration: 'PERMANENT',
        scope: { controller: 'opponent', cardTypes: ['Creature'] },
        effect: { type: 'ABILITY', removeAll: true },
      },
    }]);
    expect(CardCharacteristicService.resolveAbilities(engine.roomState, live(engine, kasnas)).map(a => a.id))
      .toContain('worlds-winter-protection');
    expect(CardCharacteristicService.resolveAbilities(engine.roomState, live(engine, other))).toEqual([]);
  });

  it('still settles damage that was lethal before Kasnas entered the battlefield', () => {
    const ally = card('worlds-sea-lord', 'battlefield');
    const enemy = card('sea-patrol', 'battlefield', 'player2');
    const kasnas = card('worlds-winter-emperor-kasnas', 'hand');
    const engine = game(ally, enemy);
    engine.roomState.players.player1.hand.push(kasnas);
    engine.applyMutations([
      ...planDamage(engine.roomState, [{
        source: captureSourceInformation(engine.roomState, enemy),
        recipient: { kind: 'permanent', cardUuid: ally.uuid, zoneRevision: 0 },
        amount: 30, combat: false,
      }]),
      { type: 'MOVE_CARD', cardUuid: kasnas.uuid, playerId: 'player1', from: 'hand', to: 'battlefield' },
    ]);
    expect(engine.roomState.battlefield.map(card => card.uuid)).toContain(kasnas.uuid);
    expect(engine.roomState.players.player1.graveyard.map(card => card.uuid)).toContain(ally.uuid);
  });

  it('Kasnas untaps itself when another friendly Yuer taps during the opposing attack phase', () => {
    const kasnas = card('worlds-winter-emperor-kasnas', 'battlefield');
    kasnas.state.isTapped = true;
    const ally = card('worlds-sea-lord', 'battlefield');
    const other = card('aurora-ice-dragon', 'battlefield');
    const engine = game(kasnas, ally, other);
    engine.roomState.phase = 'beginCombatStep';
    engine.applyMutations([{ type: 'TAP_CARD', cardUuid: ally.uuid }]);
    expect(engine.roomState.stack).toHaveLength(0);
    engine.applyMutations([{ type: 'UNTAP_CARD', cardUuid: ally.uuid }]);

    engine.roomState.activeTurnPlayerId = 'player2';
    engine.applyMutations([{ type: 'TAP_CARD', cardUuid: other.uuid }]);
    expect(engine.roomState.stack).toHaveLength(0);
    engine.applyMutations([{ type: 'TAP_CARD', cardUuid: ally.uuid }]);
    expect(engine.roomState.stack).toHaveLength(1);
    resolve(engine);
    expect(live(engine, kasnas).state.isTapped).toBe(false);
    expect(live(engine, ally).state.isTapped).toBe(true);
  });

  it('Namalan untaps the chosen beast only after a new opposing tap in your combat', () => {
    const namalan = card('wind-spirit-banner-namalan', 'battlefield');
    const friendly = card('wind-spirit-hornblower-murad', 'battlefield');
    friendly.state.isTapped = true;
    const enemy = card('sea-patrol', 'battlefield', 'player2');
    const engine = game(namalan, friendly, enemy);
    engine.roomState.phase = 'beginCombatStep';
    engine.applyMutations([{ type: 'TAP_CARD', cardUuid: enemy.uuid }]);
    const choice = engine.roomState.pendingChoice;
    if (!choice || choice.kind === 'number') throw new Error('Expected targeting choice');
    expect(choice.options).toHaveLength(1);
    choose(engine, [choice.options[0].id]);
    resolve(engine);
    choose(engine, ['yes']);
    expect(live(engine, friendly).state.isTapped).toBe(false);
    expect(CardCharacteristicService.resolveAbilities(engine.roomState, live(engine, enemy))).toEqual([]);
    engine.applyMutations([{ type: 'UNTAP_CARD', cardUuid: enemy.uuid }]);
    expect(CardCharacteristicService.resolveAbilities(engine.roomState, live(engine, enemy)).map(ability => ability.id))
      .toEqual(enemy.blueprint.abilities.map(ability => ability.id));
    engine.applyMutations([{ type: 'TAP_CARD', cardUuid: friendly.uuid }, { type: 'TAP_CARD', cardUuid: enemy.uuid }]);
    expect(engine.roomState.stack).toEqual([]);
    expect(engine.roomState.pendingChoice).toBeFalsy();
    expect(live(engine, friendly).state.isTapped).toBe(true);
  });

  it('Galar marks the entering Wind Beast rather than the listener', () => {
    const source = card('wind-emperor-leon-galar', 'battlefield');
    const entrant = card('wind-spirit-banner-namalan', 'hand');
    const engine = game(source);
    expect(cast(engine, entrant).success).toBe(true);
    resolve(engine);
    resolve(engine);
    choose(engine, ['yes']);
    expect(live(engine, entrant).state.counters['+1/+1']).toBe(1);
    expect(live(engine, source).state.counters['+1/+1']).toBeUndefined();
  });

  it('Ice Ridge Lord reduces damage on friendly marked dragons even when it cannot be prevented', () => {
    const lord = card('ice-ridge-lord', 'battlefield');
    const ally = card('aurora-ice-dragon', 'battlefield');
    const enemy = card('aurora-ice-dragon', 'battlefield', 'player2');
    const dealer = card('sea-patrol', 'battlefield', 'player2');
    ally.state.counters.aurora = 1;
    enemy.state.counters.aurora = 1;
    const engine = game(lord, ally, enemy, dealer);
    engine.applyMutations(planDamage(engine.roomState, [ally, enemy].map(target => ({
      recipient: { kind: 'permanent', cardUuid: target.uuid, zoneRevision: 0 },
      source: captureSourceInformation(engine.roomState, dealer), amount: 2, combat: false, preventable: false,
    }))));
    expect(live(engine, ally).state.damageTaken).toBe(1);
    expect(live(engine, enemy).state.damageTaken).toBe(2);
  });

  it('Frostmoon Guardian offers payment per attacker and cancels only the chosen attack', () => {
    const guardian = card('frostmoon-guardian', 'battlefield');
    const enemies = Array.from({ length: 2 }, () => card('sea-patrol', 'battlefield', 'player2'));
    const engine = game(guardian, ...enemies);
    engine.roomState.activeTurnPlayerId = 'player2';
    engine.roomState.phase = 'declareAttackersStep';
    engine.roomState.priorityPlayerId = null;
    expect(engine.executePlayerAction('player2', 'declare_attackers', {
      attackers: enemies.map(value => ({ cardUuid: value.uuid })),
    }).success).toBe(true);
    const order = engine.roomState.pendingChoice;
    if (order?.kind === 'ordering') choose(engine, order.options.map(option => option.id));
    const first = engine.roomState.stack.at(-1);
    if (first?.type !== 'triggered') throw new Error('Expected a response to an attacker');
    const cancelled = (first.triggeringEvent?.payload.card as CardInstance).uuid;
    resolve(engine);
    choose(engine, ['yes']);
    expect(engine.roomState.combat.map(item => item.attacker.uuid)).toEqual(enemies.filter(item => item.uuid !== cancelled).map(item => item.uuid));
    expect(engine.roomState.players.player1.mana.white).toBe(3);
    expect(enemies.every(enemy => live(engine, enemy).state.attackedThisTurn && live(engine, enemy).state.isTapped)).toBe(true);
    resolve(engine);
    choose(engine, ['no']);
    expect(engine.roomState.combat).toHaveLength(1);
  });
});

it.each([true, false])('Phantom Giant mills three before its optional Puppet summon (summon: %s)', summon => {
  const giant = card('phantom-giant', 'battlefield');
  const engine = game(giant);
  const deep = card('phantom-puppet', 'library');
  const puppet = card('phantom-puppet', 'library');
  const land = card('phantom-underworld', 'library');
  const enemyKind = card('sea-patrol', 'library');
  engine.roomState.players.player1.deck = [deep, land, puppet, enemyKind];

  attackWith(engine, giant);
  resolve(engine);
  const player = engine.roomState.players.player1;
  expect(player.deck.map(card => card.uuid)).toEqual([deep.uuid]);
  expect(player.graveyard.map(card => card.uuid)).toEqual([enemyKind.uuid, puppet.uuid, land.uuid]);
  const choice = engine.roomState.pendingChoice;
  if (choice?.kind !== 'search') throw new Error('Expected graveyard Puppet search');
  expect(choice.options.map(option => option.id)).toEqual([puppet.uuid]);
  expect([choice.min, choice.max]).toEqual([0, 1]);
  choose(engine, summon ? [puppet.uuid] : []);
  expect(live(engine, puppet)?.state.summonKind).toBe(summon ? 'effect' : undefined);
  expect(engine.roomState.players.player1.graveyard.some(card => card.uuid === puppet.uuid)).toBe(!summon);
});

it.each([true, false])('Ghostaxe gains attack only when its life reduction kills the target (lethal: %s)', lethal => {
  const ghostaxe = card('phantom-ghostaxe', 'battlefield');
  const target = card(lethal ? 'empire-servant' : 'abyss-giant', 'battlefield', 'player2');
  const engine = game(ghostaxe, target);
  const targetMaxLife = CardCharacteristicService.resolveToughness(engine.roomState, target);

  attackWith(engine, ghostaxe);
  const choice = engine.roomState.pendingChoice;
  if (!choice || choice.kind === 'number') throw new Error('Expected an attack trigger target');
  const option = choice.options.find(option => (option.value as { cardUuid?: string }).cardUuid === target.uuid);
  if (!option) throw new Error('Expected the opposing creature as a target');
  choose(engine, [option.id]);
  resolve(engine);

  expect(CardCharacteristicService.resolvePower(engine.roomState, live(engine, ghostaxe))).toBe(lethal ? 4 : 2);
  expect(engine.roomState.players.player2.graveyard.map(card => card.uuid)).toEqual(lethal ? [target.uuid] : []);
  expect(engine.roomState.players.player2.exile ?? []).toEqual([]);
  if (!lethal) {
    expect(CardCharacteristicService.resolveToughness(engine.roomState, live(engine, target))).toBe(targetMaxLife - 3);
  }
  engine.applyMutations([{ type: 'CLEAR_END_OF_TURN_EFFECTS' }]);
  expect(CardCharacteristicService.resolvePower(engine.roomState, live(engine, ghostaxe))).toBe(2);
  if (!lethal) {
    expect(CardCharacteristicService.resolveToughness(engine.roomState, live(engine, target))).toBe(targetMaxLife - 3);
  }
});

it.each(['pay', 'decline', 'unaffordable'] as const)('Beast Emperor Command orders the reveal remainder after paid deployment (%s)', decision => {
  const engine = game();
  const command = card('beast-emperor-command', 'hand');
  const deep = card('wind-beast-rabbit', 'library');
  const eligible = card('wind-beast-fox', 'library');
  const wrongName = card('wind-spirit-prophet', 'library');
  const land = card('beast-holy-land', 'library');
  engine.roomState.players.player1.mana = {
    red: 0, black: 0, green: decision === 'unaffordable' ? 3 : 4, blue: 0, white: 0, yellow: 0,
  };
  engine.roomState.players.player1.deck = [deep, land, wrongName, eligible];
  expect(cast(engine, command).success).toBe(true);
  resolve(engine);
  if (decision !== 'unaffordable') choose(engine, [decision === 'pay' ? 'yes' : 'no']);
  if (decision === 'pay') {
    const deployment = engine.roomState.pendingChoice;
    if (deployment?.kind !== 'search') throw new Error('Expected revealed creature search');
    expect(deployment.options.map(option => option.id)).toEqual([eligible.uuid]);
    choose(engine, [eligible.uuid]);
  }
  expect(live(engine, eligible)?.state.summonKind).toBe(decision === 'pay' ? 'effect' : undefined);
  expect(engine.roomState.players.player1.mana.green).toBe(decision === 'decline' ? 1 : 0);
  const returned = decision === 'pay' ? [land.uuid, wrongName.uuid] : [land.uuid, eligible.uuid, wrongName.uuid];
  choose(engine, returned);
  expect(engine.roomState.players.player1.deck.map(card => card.uuid)).toEqual([...returned.reverse(), deep.uuid]);
  expect(engine.roomState.pendingChoice).toBeNull();
});

it('Heavenly Divine City summons one vanilla Angel through its entry trigger', () => {
  const engine = game();
  const city = card('heavenly-divine-city', 'hand');
  expect(cast(engine, city).success).toBe(true);
  resolve(engine);
  expect(live(engine, city)).toBeDefined();
  expect(engine.roomState.battlefield.filter(card => card.isToken)).toHaveLength(0);
  resolve(engine);
  const tokens = engine.roomState.battlefield.filter(card => card.isToken);
  expect(tokens).toHaveLength(1);
  expect(tokens[0]).toMatchObject({
    blueprint: { power: 1, toughness: 1, subTypes: ['上使'], abilities: [] },
    state: { controllerId: 'player1', summoningSickness: true },
  });
});

it.each([true, false])('Heavenly Beast heals for yellow revealed cards and takes only a yellow land (land: %s)', hasLand => {
  const engine = game();
  const beast = card('heavenly-beast', 'hand');
  const outside = card('angel-holy-land', 'library');
  const candidate = card(hasLand ? 'angel-holy-land' : 'land-red', 'library');
  const yellowNonland = card('winged-envoy', 'library');
  const other = card('sea-domain', 'library');
  engine.roomState.players.player1.deck = [outside, other, yellowNonland, candidate];
  expect(cast(engine, beast).success).toBe(true);
  resolve(engine);
  resolve(engine);
  expect(engine.roomState.players.player1.life).toBe(hasLand ? 22 : 21);
  if (hasLand) {
    const choice = engine.roomState.pendingChoice;
    if (choice?.kind !== 'search') throw new Error('Expected yellow land search');
    expect(choice.options.map(option => option.id)).toEqual([candidate.uuid]);
    choose(engine, [candidate.uuid]);
  }
  const order = engine.roomState.pendingChoice;
  if (order?.kind !== 'ordering') throw new Error('Expected exact remainder ordering');
  const returned = hasLand ? [other.uuid, yellowNonland.uuid] : [other.uuid, candidate.uuid, yellowNonland.uuid];
  expect(order.options.map(option => option.id).sort()).toEqual([...returned].sort());
  choose(engine, returned);
  expect(engine.roomState.players.player1.hand.map(card => card.uuid)).toEqual(hasLand ? [candidate.uuid] : []);
  expect(engine.roomState.players.player1.deck.map(card => card.uuid)).toEqual([...returned.reverse(), outside.uuid]);
});

it('Haer freezes three opposing creatures, then uses its damage sweep only once per game', () => {
  const haer = card('wind-spirit-general-haer', 'hand');
  const enemies = Array.from({ length: 4 }, () => card('sea-patrol', 'battlefield', 'player2'));
  const ally = card('wind-beast-bean', 'battlefield');
  const engine = game(ally, ...enemies);

  expect(cast(engine, haer).success).toBe(true);
  resolve(engine);
  const choice = engine.roomState.pendingChoice;
  if (!choice || choice.kind === 'number') throw new Error('Expected three entry targets');
  const selected = new Set(enemies.slice(0, 3).map(card => card.uuid));
  const available = choice.options.map(option => (option.value as { cardUuid?: string }).cardUuid);
  expect(available.sort()).toEqual(enemies.map(card => card.uuid).sort());
  choose(engine, choice.options.filter(option => selected.has((option.value as { cardUuid: string }).cardUuid))
    .map(option => option.id));
  resolve(engine);
  for (const enemy of enemies) {
    expect(live(engine, enemy).state.isTapped).toBe(selected.has(enemy.uuid));
    expect(Boolean(live(engine, enemy).state.skipNextUntap)).toBe(selected.has(enemy.uuid));
  }

  const frozen = enemies[0];
  const naturalUntap = { type: 'UNTAP_CARD', cardUuid: frozen.uuid, natural: true } as const;
  engine.applyMutations([naturalUntap]);
  expect(live(engine, frozen).state).toMatchObject({ isTapped: true, skipNextUntap: false });
  engine.applyMutations([naturalUntap]);
  expect(live(engine, frozen).state.isTapped).toBe(false);

  const action = { cardUuid: haer.uuid, abilityId: 'deal-eight-to-enemies' };
  expect(engine.executePlayerAction('player1', 'activate_ability', action).success).toBe(false);
  engine.applyMutations([{ type: 'SET_SUMMONING_SICKNESS', cardUuid: haer.uuid, value: false }]);
  expect(engine.executePlayerAction('player1', 'activate_ability', action).success).toBe(true);
  expect(live(engine, haer).state.isTapped).toBe(true);
  resolve(engine);
  expect(engine.roomState.players.player2.graveyard.map(card => card.uuid).sort()).toEqual(enemies.map(card => card.uuid).sort());
  expect(live(engine, ally).state.damageTaken).toBe(0);
  engine.applyMutations([{ type: 'UNTAP_CARD', cardUuid: haer.uuid }]);
  expect(engine.executePlayerAction('player1', 'activate_ability', action).success).toBe(false);
});

it.each([15, 16])('Far North Crown sweeps at life fifteen or lower (life: %s)', life => {
  const crown = card('far-north-crown', 'battlefield');
  const dragon = card('winter-drake', 'battlefield');
  const enemies = [card('sea-patrol', 'battlefield', 'player2'), card('sea-city-noble', 'battlefield', 'player2')];
  const enemyLand = card('sea-domain', 'battlefield', 'player2');
  const engine = game(crown, dragon, ...enemies, enemyLand);
  engine.roomState.players.player1.life = life;
  const previousLibrary = engine.roomState.players.player2.deck.map(card => card.uuid);

  expect(engine.executePlayerAction('player1', 'activate_ability', {
    cardUuid: crown.uuid, abilityId: 'attach', targets: [{ targetType: 'permanent', cardUuid: dragon.uuid }],
  }).success).toBe(true);
  resolve(engine);
  expect(CardCharacteristicService.resolvePower(engine.roomState, live(engine, dragon))).toBe(3);

  const sweep = { cardUuid: crown.uuid, abilityId: 'crown-return' };
  expect(engine.executePlayerAction('player1', 'activate_ability', sweep).success).toBe(true);
  expect(live(engine, crown).state.isTapped).toBe(true);
  resolve(engine);
  const library = engine.roomState.players.player2.deck.map(card => card.uuid);
  if (life === 15) {
    expect(library.slice(0, 2).sort()).toEqual(enemies.map(card => card.uuid).sort());
    expect(library.slice(2)).toEqual(previousLibrary);
  } else {
    expect(library).toEqual(previousLibrary);
    for (const enemy of enemies) expect(live(engine, enemy)).toBeDefined();
  }
  expect(live(engine, dragon)).toBeDefined();
  expect(live(engine, enemyLand)).toBeDefined();
  engine.applyMutations([
    { type: 'MOVE_CARD', cardUuid: crown.uuid, playerId: 'player1', from: 'battlefield', to: 'hand' },
    { type: 'MOVE_CARD', cardUuid: crown.uuid, playerId: 'player1', from: 'hand', to: 'battlefield' },
  ]);
  expect(live(engine, crown).state.isTapped).toBe(false);
  expect(engine.executePlayerAction('player1', 'activate_ability', sweep).success).toBe(false);
});

it.each(['recover', 'ineligible', 'decline'] as const)('Phantasm Altar recovers only its own qualifying mill and taps for black (%s)', decision => {
  const engine = game();
  const altar = card('phantasm-altar', 'hand');
  const older = card('hera-ghostfire', 'graveyard');
  const top = card(decision === 'ineligible' ? 'phantom-puppet' : 'hera-ghostfire', 'library');
  engine.roomState.players.player1.hand = [altar];
  engine.roomState.players.player1.deck.push(top);
  engine.roomState.players.player1.graveyard = [older];
  expect(engine.executePlayerAction('player1', 'play_land', { cardUuid: altar.uuid, zoneRevision: 0 }).success).toBe(true);
  const mana = () => engine.executePlayerAction('player1', 'tapForMana', { cardUuid: altar.uuid, abilityId: 'produce-black' });
  expect(live(engine, altar).state.isTapped).toBe(true);

  resolve(engine);
  choose(engine, [decision === 'decline' ? 'no' : 'yes']);
  if (decision === 'recover') {
    const choice = engine.roomState.pendingChoice;
    if (choice?.kind !== 'search') throw new Error('Expected one recoverable card');
    expect(choice.options.map(option => option.id)).toEqual([top.uuid]);
    choose(engine, [top.uuid]);
  }
  expect(engine.roomState.players.player1.hand.map(card => card.uuid)).toEqual(decision === 'recover' ? [top.uuid] : []);
  expect(engine.roomState.players.player1.graveyard.map(card => card.uuid))
    .toEqual(decision === 'ineligible' ? [older.uuid, top.uuid] : [older.uuid]);
  expect(engine.roomState.players.player1.deck.some(card => card.uuid === top.uuid)).toBe(decision === 'decline');
  expect(mana().success).toBe(false);
  engine.applyMutations([{ type: 'UNTAP_CARD', cardUuid: altar.uuid }]);
  const before = engine.roomState.players.player1.mana.black;
  expect(mana().success).toBe(true);
  expect(engine.roomState.players.player1.mana.black).toBe(before + 1);
  expect(live(engine, altar).state.isTapped).toBe(true);
});

it.each(['recover', 'ineligible', 'decline'] as const)('Ghostfire Scythe grants its exact mill and recovery to the equipped Puppet (%s)', decision => {
  const scythe = card('phantom-ghostfire-scythe', 'battlefield');
  const host = card('phantom-land-soldier', 'battlefield');
  const nonPuppet = card('winged-envoy', 'battlefield');
  const engine = game(scythe, host, nonPuppet);
  const top = card(decision === 'ineligible' ? 'phantom-puppet' : 'hera-ghostfire', 'library');
  engine.roomState.players.player1.deck.push(top);
  const attach = (target: CardInstance) => engine.executePlayerAction('player1', 'activate_ability', {
    cardUuid: scythe.uuid, abilityId: 'attach', targets: [{ targetType: 'permanent', cardUuid: target.uuid }],
  });
  const basePower = CardCharacteristicService.resolvePower(engine.roomState, host);
  expect(attach(nonPuppet).success).toBe(false);
  expect(attach(host).success).toBe(true);
  resolve(engine);
  expect(CardCharacteristicService.resolvePower(engine.roomState, live(engine, host))).toBe(basePower + 2);
  attackWith(engine, host);
  expect(engine.roomState.stack.at(-1)?.source.uuid).toBe(host.uuid);
  resolve(engine);
  choose(engine, [decision === 'decline' ? 'no' : 'yes']);
  if (decision === 'recover') choose(engine, [top.uuid]);
  expect(engine.roomState.players.player1.hand.map(card => card.uuid)).toEqual(decision === 'recover' ? [top.uuid] : []);
  expect(engine.roomState.players.player1.graveyard.map(card => card.uuid)).toEqual(decision === 'ineligible' ? [top.uuid] : []);
  expect(engine.roomState.players.player1.deck.some(card => card.uuid === top.uuid)).toBe(decision === 'decline');
  engine.applyMutations([{ type: 'MOVE_CARD', cardUuid: scythe.uuid, playerId: 'player1', from: 'battlefield', to: 'hand' }]);
  expect(CardCharacteristicService.resolvePower(engine.roomState, live(engine, host))).toBe(basePower);
  expect(CardCharacteristicService.resolveAbilities(engine.roomState, live(engine, host))
    .some(ability => ability.id.includes('ghostfire-scythe-attack'))).toBe(false);
});

it('Arthur converts actual blocked combat damage to half damage to the opponent', () => {
  const arthur = card('far-north-dragon-emperor-arthur', 'battlefield');
  const blocker = creature('arthur-blocker', 'player2', 4, 8);
  const engine = game(arthur, blocker);
  attackWith(engine, arthur);
  expect(engine.passPriority('player1').success).toBe(true);
  expect(engine.passPriority('player2').success).toBe(true);
  expect(engine.executePlayerAction('player2', 'declare_blockers', {
    assignments: [{ attackerUuid: arthur.uuid, blockerUuids: [blocker.uuid] }],
  }).success).toBe(true);
  expect(engine.passPriority('player1').success).toBe(true);
  expect(engine.passPriority('player2').success).toBe(true);
  answerSingleRecipientCombat(engine);
  expect(live(engine, blocker).state.damageTaken).toBe(7);
  expect(live(engine, arthur).state.damageTaken).toBe(4);
  expect(engine.roomState.players.player2.life).toBe(20);
  expect(engine.roomState.stack.at(-1)?.ability?.id).toBe('arthur-creature-damage');
  resolve(engine);
  expect(engine.roomState.players.player2.life).toBe(17);
  expect(engine.roomState.stack).toEqual([]);
});

it.each([
  ['winter-drake', 'player1', true],
  ['empire-servant', 'player1', false],
  ['winter-drake', 'player2', false],
] as const)('Ice Ridge Lord draws only when a friendly Ice Dragon attacks (%s, %s)', (id, playerId, draws) => {
  const lord = card('ice-ridge-lord', 'battlefield');
  const attacker = card(id, 'battlefield', playerId);
  const engine = game(lord, attacker);
  const top = engine.roomState.players.player1.deck.at(-1)!;
  engine.roomState.activeTurnPlayerId = playerId;
  engine.roomState.phase = 'declareAttackersStep';
  engine.roomState.priorityPlayerId = null;
  expect(engine.executePlayerAction(playerId, 'declare_attackers', {
    attackers: [{ cardUuid: attacker.uuid }],
  }).success).toBe(true);
  expect(engine.roomState.stack).toHaveLength(draws ? 1 : 0);
  if (draws) resolve(engine);
  expect(engine.roomState.players.player1.hand.map(card => card.uuid)).toEqual(draws ? [top.uuid] : []);
});

it('Aleya taps for cold without opening the stack or spending charge', () => {
  const aleya = card('coldnest-lord-aleya', 'battlefield');
  aleya.state.counters.charge = 4;
  const engine = game(aleya);
  expect(engine.executePlayerAction('player1', 'tapForMana', { cardUuid: aleya.uuid, abilityId: 'mana' }).success).toBe(true);
  expect(engine.roomState.players.player1.mana.white).toBe(6);
  expect(live(engine, aleya).state).toMatchObject({ isTapped: true, counters: { charge: 4 } });
  expect(engine.roomState.stack).toEqual([]);
});

it.each([
  ['beast-holy-land', 'wind-spirit-regrowth'],
  ['demon-sea-spire', 'beast-emperor-command'],
] as const)('Murad deploys %s for free before %s can claim itself', (deployedId, recoveredId) => {
  const engine = game();
  const deployed = card(deployedId, 'library');
  const recovered = card(recoveredId, 'library');
  const equipment = card('vitality-wood-staff', 'library');
  const rest = [equipment, card('sea-patrol', 'library'), card('sea-depths', 'library')];
  const deep = card('beast-holy-land', 'library');
  engine.roomState.players.player1.deck = [deep, ...rest, deployed, recovered];
  expect(cast(engine, card('wind-spirit-hornblower-murad', 'hand')).success).toBe(true);
  resolve(engine);
  const mana = { ...engine.roomState.players.player1.mana };
  resolve(engine);
  const deployment = engine.roomState.pendingChoice;
  if (deployment?.kind !== 'search') throw new Error('Expected the reveal deployment choice');
  expect(deployment.options.map(option => option.id)).toEqual([deployed.uuid]);
  choose(engine, [deployed.uuid]);
  expect(live(engine, deployed).state.summonKind).toBe('effect');
  expect(engine.roomState.players.player1.mana).toEqual(mana);
  expect(engine.roomState.turnHistory?.landPlays?.player1 ?? 0).toBe(0);
  expect(engine.roomState.stack.some(object => object.source.uuid === recovered.uuid)).toBe(false);
  expect(engine.roomState.pendingChoice?.kind).toBe('ordering');
  choose(engine, [recovered.uuid, ...rest.map(card => card.uuid)]);
  expect(engine.roomState.stack.at(-1)?.source.uuid).toBe(recovered.uuid);
  resolve(engine);
  choose(engine, ['yes']);
  expect(engine.roomState.players.player1.hand.map(card => card.uuid)).toEqual([recovered.uuid]);
  expect(engine.roomState.players.player1.deck.map(card => card.uuid)).toEqual([...rest].reverse().map(card => card.uuid).concat(deep.uuid));
});

it('Blade Wolf still deploys its land but cannot reveal if four cards remain in hand', () => {
  const engine = game();
  const land = card('beast-holy-land', 'hand');
  engine.roomState.players.player1.hand = [land, ...Array.from({ length: 4 }, () => card('sea-depths', 'hand'))];
  const deck = engine.roomState.players.player1.deck.map(card => card.uuid);
  expect(cast(engine, card('wind-spirit-blade-wolf', 'hand')).success).toBe(true);
  resolve(engine);
  resolve(engine);
  choose(engine, [land.uuid]);
  expect(live(engine, land)).toBeDefined();
  expect(engine.roomState.players.player1.hand).toHaveLength(4);
  expect(engine.roomState.pendingChoice).toBeFalsy();
  expect(engine.roomState.stack).toEqual([]);
  expect(engine.roomState.players.player1.deck.map(card => card.uuid)).toEqual(deck);
});

it('Wind Spirit Beast Wrath taps exactly two opposing creatures on the opponent’s turn', () => {
  const spell = card('wind-spirit-beast-wrath', 'hand');
  const enemies = Array.from({ length: 3 }, () => card('sea-patrol', 'battlefield', 'player2'));
  const ally = card('wind-beast-bean', 'battlefield');
  const engine = game(ally, ...enemies);
  engine.roomState.players.player1.hand = [spell];
  engine.roomState.activeTurnPlayerId = 'player2';
  const use = (targets: CardInstance[]) => engine.executePlayerAction('player1', 'cast_spell', {
    cardUuid: spell.uuid, targets: targets.map(card => ({ targetType: 'permanent', cardUuid: card.uuid })),
  });
  expect(use([enemies[0], ally]).success).toBe(false);
  expect(use(enemies.slice(0, 2)).success).toBe(true);
  resolve(engine);
  expect(enemies.map(card => live(engine, card).state.isTapped)).toEqual([true, true, false]);
  expect(live(engine, ally).state.isTapped).toBe(false);
});

it.each([true, false])('Wind Beast Son counts its printed name and optionally freezes an enemy (%s)', freeze => {
  const son = card('wind-spirit-beast-son', 'hand');
  const enemy = card('sea-city-noble', 'battlefield', 'player2');
  const engine = game(enemy);
  expect(cast(engine, son).success).toBe(true);
  resolve(engine);
  const target = engine.roomState.pendingChoice;
  if (target?.kind !== 'targets') throw new Error('Expected the opposing creature as a target');
  choose(engine, [target.options[0].id]);
  resolve(engine);
  choose(engine, [freeze ? 'yes' : 'no']);
  expect(CardCharacteristicService.resolve(engine.roomState, live(engine, son))).toMatchObject({ power: 3, toughness: 4 });
  expect(live(engine, enemy).state.isTapped).toBe(freeze);
  if (freeze) {
    const naturalUntap = { type: 'UNTAP_CARD', cardUuid: enemy.uuid, natural: true } as const;
    engine.applyMutations([naturalUntap]);
    expect(live(engine, enemy).state.isTapped).toBe(true);
    engine.applyMutations([naturalUntap]);
    expect(live(engine, enemy).state.isTapped).toBe(false);
  }
});

it.each(['equipment', 'decline'] as const)('Frost Messenger can keep an Ice Dragon equipment on top or decline the reveal (%s)', decision => {
  const engine = game();
  const equipment = card('far-north-crown', 'library');
  const other = card('sea-patrol', 'library');
  const top = card('land-red', 'library');
  engine.roomState.players.player1.deck = [equipment, other, top];
  expect(cast(engine, card('frost-messenger', 'hand')).success).toBe(true);
  resolve(engine);
  resolve(engine);
  choose(engine, [decision === 'decline' ? 'skip' : 'reveal']);
  if (decision === 'equipment') {
    const search = engine.roomState.pendingChoice;
    if (search?.kind !== 'search') throw new Error('Expected the Ice Dragon selection');
    expect(search.options.map(option => option.id)).toEqual([equipment.uuid]);
    choose(engine, [equipment.uuid]);
    choose(engine, [other.uuid, top.uuid]);
  }
  expect(engine.roomState.players.player1.deck.map(card => card.uuid))
    .toEqual(decision === 'equipment' ? [top.uuid, other.uuid, equipment.uuid] : [equipment.uuid, other.uuid, top.uuid]);
  const revealed = engine.drainEventBatches().flatMap(batch => batch.events).filter(event => event.eventId === 'CARD_REVEALED');
  expect(revealed).toHaveLength(decision === 'equipment' ? 3 : 0);
});

it.each(['deployment', 'reveal'] as const)('Lysandria only takes cards after accepting the optional reveal (declines %s)', step => {
  const marked = card('ice-ridge-lord', 'battlefield');
  marked.state.counters.aurora = 1;
  const guide = card('northern-guide-lysandria', 'hand');
  const engine = game(marked);
  engine.roomState.players.player1.deck.push(card('icewind-guardian', 'library'));
  engine.roomState.players.player1.hand = [guide];
  const library = engine.roomState.players.player1.deck.map(card => card.uuid);
  engine.applyMutations([{ type: 'MOVE_CARD', cardUuid: marked.uuid, playerId: 'player1', from: 'battlefield', to: 'exile' }]);
  resolve(engine);
  choose(engine, [step === 'deployment' ? 'no' : 'yes']);
  if (step === 'reveal') {
    expect(live(engine, guide).state.summonKind).toBe('effect');
    resolve(engine);
    choose(engine, ['skip']);
  }
  expect(engine.roomState.players.player1.hand.map(card => card.uuid)).toEqual(step === 'deployment' ? [guide.uuid] : []);
  expect(engine.roomState.players.player1.deck.map(card => card.uuid)).toEqual(library);
  expect(engine.roomState.stack).toEqual([]);
  expect(engine.roomState.pendingChoice).toBeFalsy();
});

it.each([true, false])('Dragon Tomb can be declined and caps a rescued Dragon at its maximum life (%s)', rescue => {
  const relic = card('dragon-tomb', 'battlefield');
  const dragon = card('frost-messenger', 'battlefield');
  const source = card('sea-patrol', 'battlefield', 'player2');
  const engine = game(relic, dragon, source);
  const cap = CardCharacteristicService.resolveToughness(engine.roomState, dragon);
  expect(cap).toBeLessThan(3);
  engine.applyMutations(planDamage(engine.roomState, [{
    source: captureSourceInformation(engine.roomState, source),
    recipient: { kind: 'permanent', cardUuid: dragon.uuid, zoneRevision: 0 },
    amount: cap + 3, combat: false, preventable: false,
  }]));
  const recovery = engine.roomState.pendingChoice;
  if (recovery?.kind !== 'options') throw new Error('Expected Tomb rescue choice');
  const option = recovery.options.find(option => option.id.startsWith('skip:') !== rescue);
  if (!option) throw new Error('Expected one matching rescue answer');
  choose(engine, [option.id]);
  const survivor = live(engine, dragon);
  if (rescue) expect(survivor.state.damageTaken).toBe(0);
  else expect(survivor).toBeUndefined();
  expect(live(engine, relic) !== undefined).toBe(!rescue);
  expect(engine.roomState.players.player1.graveyard.map(card => card.uuid)).toEqual([rescue ? relic.uuid : dragon.uuid]);
});

it('Holy Energy Haste heals during an opponent turn and rejects the bottom-draw mode there', () => {
  const engine = game();
  engine.roomState.activeTurnPlayerId = 'player2';
  const spell = card('holy-energy-haste', 'hand');
  engine.roomState.players.player1.hand = [spell];
  const use = (mode: string) => engine.executePlayerAction('player1', 'cast_spell', { cardUuid: spell.uuid, modes: [mode] });
  expect(use('bottom-draw').success).toBe(false);
  expect(use('heal').success).toBe(true);
  resolve(engine);
  expect(engine.roomState.players.player1.life).toBe(21);
  expect(engine.roomState.players.player1.hand).toEqual([]);
});

it.each(['recover', 'ineligible'] as const)('Phantom Ghostfire mills on attack and filters that exact result (%s)', decision => {
  const ghostfire = card('phantom-ghostfire', 'battlefield');
  const engine = game(ghostfire);
  const recent = card(decision === 'recover' ? 'hera-ghostfire' : 'phantom-puppet', 'library');
  const older = card('hera-ghostfire', 'graveyard');
  engine.roomState.players.player1.deck.push(recent);
  engine.roomState.players.player1.graveyard = [older];
  attackWith(engine, ghostfire);
  resolve(engine);
  choose(engine, ['yes']);
  if (decision === 'recover') {
    const choice = engine.roomState.pendingChoice;
    if (choice?.kind !== 'search') throw new Error('Expected the recent card');
    expect(choice.options.map(option => option.id)).toEqual([recent.uuid]);
    choose(engine, [recent.uuid]);
  }
  expect(engine.roomState.players.player1.hand.map(card => card.uuid)).toEqual(decision === 'recover' ? [recent.uuid] : []);
  expect(engine.roomState.players.player1.graveyard.map(card => card.uuid))
    .toEqual(decision === 'ineligible' ? [older.uuid, recent.uuid] : [older.uuid]);
  expect(engine.roomState.pendingChoice).toBeFalsy();
});

it.each([20, 1])('Phantom Dreamer can leave the normal turn draw as the only draw (life: %s)', life => {
  const dreamer = card('phantom-dreamer', 'battlefield');
  const engine = game(dreamer);
  engine.roomState.players.player1.life = life;
  engine.roomState.phase = 'upkeepStep';
  engine.roomState.turnNumber = 2;
  engine.applyMutations(new StateMachine(engine.roomState).transition(engine.roomState, 'stateDrawPhase'));
  expect(engine.roomState.players.player1.hand).toHaveLength(1);
  resolve(engine);
  if (life === 20) choose(engine, ['no']);
  else expect(engine.roomState.pendingChoice).toBeFalsy();
  expect(engine.roomState.players.player1.life).toBe(life);
  expect(engine.roomState.players.player1.hand).toHaveLength(1);
  expect(engine.roomState.stack).toEqual([]);
});

it('Galar freezes only his three chosen opponents and refreshes the attack trigger next turn', () => {
  const galar = card('wind-emperor-leon-galar', 'battlefield');
  const enemies = Array.from({ length: 4 }, () => card('sea-city-noble', 'battlefield', 'player2'));
  const engine = game(galar, ...enemies);
  const clearAttack = () => engine.applyMutations([
    { type: 'CLEAR_COMBAT' },
    { type: 'UNTAP_CARD', cardUuid: galar.uuid },
    { type: 'SET_ATTACKED_THIS_TURN', cardUuid: galar.uuid, value: false },
  ]);
  attackWith(engine, galar);
  const choice = engine.roomState.pendingChoice;
  if (choice?.kind !== 'targets') throw new Error('Expected three opposing freeze targets');
  expect([choice.min, choice.max]).toEqual([3, 3]);
  expect(choice.options).toHaveLength(4);
  choose(engine, choice.options.slice(0, 3).map(option => option.id));
  resolve(engine);
  expect(enemies.filter(enemy => live(engine, enemy).state.isTapped)).toHaveLength(3);
  expect(enemies.filter(enemy => live(engine, enemy).state.skipNextUntap)).toHaveLength(3);

  // Reopen a test combat in the same turn to isolate the ability's own limit.
  clearAttack();
  attackWith(engine, galar);
  expect(engine.roomState.pendingChoice).toBeFalsy();
  expect(engine.roomState.stack).toEqual([]);
  clearAttack();
  engine.applyMutations([{ type: 'SET_TURN', playerId: 'player1', advance: true }]);
  attackWith(engine, galar);
  expect(engine.roomState.pendingChoice?.kind).toBe('targets');
});

it.each(['redirect', 'duplicate', 'hexproof', 'power', 're-entered'] as const)(
  'Icewind Guardian respects the original group and target restrictions (%s)', scenario => {
    const dragon = card('ice-ridge-lord', 'battlefield');
    const guardian = card('icewind-guardian', 'battlefield');
    const engine = game(dragon, guardian);
    const spell = card('empire-servant', 'hand', 'player2');
    const twoCreatures = scenario === 'duplicate';
    spell.blueprint = {
      ...spell.blueprint, cardTypes: ['Spell'],
      castRequirements: { allowedZones: ['hand'], speed: 'instant', cost: {} },
      onCastEffects: [
        {
          targetGroup: 'creatures', action: 'ADD_COUNTER', params: { counterType: 'scorch', amount: 1 },
          targeting: {
            type: 'permanent', cardTypes: ['Creature'], controller: 'opponent', required: true,
            minTargets: twoCreatures ? 2 : 1, maxTargets: twoCreatures ? 2 : 1,
            ...(scenario === 'power' ? { power: { max: 2 } } : {}),
          },
        },
        {
          targetGroup: 'player', action: 'MODIFY_LIFE', params: { amount: -2 },
          targeting: { type: 'player', controller: 'opponent', required: true, maxTargets: 1 },
        },
      ],
    };
    if (scenario === 'power') dragon.blueprint = { ...dragon.blueprint, power: 2 };
    if (scenario === 'hexproof') guardian.blueprint = { ...guardian.blueprint, keywords: ['Hexproof'] };
    engine.roomState.priorityPlayerId = 'player2';
    engine.roomState.players.player2.hand = [spell];
    const creatures = [dragon, ...(twoCreatures ? [guardian] : [])];
    expect(engine.executePlayerAction('player2', 'cast_spell', {
      cardUuid: spell.uuid, targetGroups: [
        { id: 'creatures', targets: creatures.map(value => ({ targetType: 'permanent', cardUuid: value.uuid })) },
        { id: 'player', targets: [{ targetType: 'player', playerId: 'player1' }] },
      ],
    }).success).toBe(true);
    const originalSpell = engine.roomState.stack[0];
    expect(engine.roomState.stack.at(-1)).toMatchObject({ type: 'triggered', source: { uuid: guardian.uuid } });
    if (scenario === 're-entered') {
      engine.applyMutations([
        { type: 'MOVE_CARD', cardUuid: guardian.uuid, playerId: 'player1', from: 'battlefield', to: 'exile' },
        { type: 'MOVE_CARD', cardUuid: guardian.uuid, playerId: 'player1', from: 'exile', to: 'battlefield' },
      ]);
      expect(live(engine, guardian).state.zoneRevision).not.toBe(guardian.state.zoneRevision);
      const entry = engine.roomState.stack.at(-1);
      if (entry?.type === 'triggered' && entry.ability?.id === 'entry-aurora') resolve(engine);
    }
    resolve(engine);
    if (engine.roomState.pendingChoice) choose(engine, ['yes']);
    const pending = engine.roomState.stack[0];
    const redirected = scenario === 'redirect';
    expect(pending.targetGroups?.[0].targets.map(target => target.cardUuid))
      .toEqual(redirected ? [guardian.uuid] : creatures.map(value => value.uuid));
    expect(pending.targetGroups?.[1]).toEqual(originalSpell.targetGroups?.[1]);
    expect(pending.effects[1]).toEqual(originalSpell.effects[1]);
    resolve(engine);
    expect(engine.roomState.players.player1.life).toBe(18);
    expect(live(engine, dragon).state.counters.scorch ?? 0).toBe(redirected ? 0 : 1);
    expect(live(engine, guardian).state.counters.scorch ?? 0).toBe(redirected || twoCreatures ? 1 : 0);
  },
);
