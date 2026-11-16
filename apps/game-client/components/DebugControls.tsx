import { ACTION_IDS, type ActionIdOrAbility } from '@card-game/protocol';
import type { DebugMode } from '@card-game/protocol';

interface DebugControlsProps {
  mode: DebugMode;
  stackLength: number;
  ready: boolean;
  actions?: readonly ActionIdOrAbility[];
  onAction: (actionId: ActionIdOrAbility) => void;
}

export default function DebugControls({ mode, stackLength, ready, actions, onAction }: DebugControlsProps) {
  if (!ready || mode === 'off') return null;
  const canResolve = actions?.includes(ACTION_IDS.resolveStack) ?? stackLength > 0;
  const canEndTurn = actions?.includes(ACTION_IDS.endTurn) ?? (mode === 'flow' && stackLength === 0);
  if (!canResolve && !canEndTurn) return null;

  return (
    <details className="debug-controls" aria-label="Debug actions">
      <summary>Debug actions</summary>
      {canResolve && <button onClick={() => onAction(ACTION_IDS.resolveStack)}>Resolve Stack</button>}
      {canEndTurn && <button onClick={() => onAction(ACTION_IDS.endTurn)}>End Turn</button>}
    </details>
  );
}
