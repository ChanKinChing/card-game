import { expect, it } from 'vitest';
import { GameEngine } from '@engine/game-engine';
import { createRoom, joinRoom } from '@engine/room-factory';
import { gameConfig } from '@config';

it.each([false, true])('starts with a specified seat and applies the first draw rule (%s)', firstPlayerDrawsOnFirstTurn => {
  const setup = { ...gameConfig.setup, firstPlayerDrawsOnFirstTurn, openingHandSize: 2 };
  const cards = ['land-red', 'land-red', 'empire-servant', 'empire-servant'];
  const room = createRoom('room', 'one', cards, { setup, debugMode: 'off' });
  joinRoom(room, 'two', cards);
  const engine = new GameEngine(room); engine.initRoom();
  try {
    expect(() => engine.startMatch('outsider')).toThrow();
    expect(engine.roomState).toBe(room);
    engine.startMatch('two');
    expect(engine.roomState).toMatchObject({ status: 'playing', phase: 'upkeepStep', activeTurnPlayerId: 'two', priorityPlayerId: 'two', turnNumber: 1 });
    expect(engine.roomState.players.two.hand).toHaveLength(2);
    engine.advancePhase('complete');
    expect(engine.roomState.phase).toBe('stateDrawPhase');
    expect(engine.roomState.players.two.hand).toHaveLength(firstPlayerDrawsOnFirstTurn ? 3 : 2);
    expect(engine.roomState.players.one.hand).toHaveLength(2);
    expect(() => engine.startMatch('one')).toThrow();
    expect(engine.roomState.players.two.hand).toHaveLength(firstPlayerDrawsOnFirstTurn ? 3 : 2);
  } finally { engine.dispose(); }
});
