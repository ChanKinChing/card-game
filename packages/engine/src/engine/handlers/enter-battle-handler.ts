// src/engine/handlers/enter-battle-handler.ts
import type { ActionHandler, ActionData, ActionResult } from '../action-registry';
import type { GameRoom, PlayerId } from '../../types/game.room.types';
import type { StackObject } from '../../types/effect.types';

/**
 * Pass toward combat from the precombat main phase.
 *
 * This is a direct action with no stack object. The player command descriptor
 * passes priority after validation; the opponent can respond before combat.
 *
 * Validation blocks non-playing rooms, a non-empty stack, non-turn players, and any phase
 * other than the main phase.
 */
export const enterBattleHandler: ActionHandler = {
  validate(room: GameRoom, playerId: PlayerId, _action: ActionData): ActionResult {
    if (room.status !== 'playing') {
      return { success: false, phase: 'validate', reason: 'Match has not started or is already over' };
    }

    // Guard: combat cannot start while anything is still waiting to resolve.
    if (room.stack.length > 0) {
      return { success: false, phase: 'validate', reason: 'Cannot enter battle while the stack is not empty!' };
    }

    // Guard: only the active player may move the game forward.
    if (room.activeTurnPlayerId !== playerId) {
      return { success: false, phase: 'validate', reason: 'Not your turn!' };
    }

    // Guard: combat is entered from the main phase only.
    if (room.phase !== 'stateMainPhase') {
      return { success: false, phase: 'validate', reason: 'Can only enter battle from the main phase!' };
    }

    return { success: true };
  },

  propose(_room: GameRoom, _playerId: PlayerId, _action: ActionData): ActionResult {
    return { success: true };
  },

  resolve(_room: GameRoom, _stackObj: StackObject): ActionResult {
    return { success: true };
  },
};
