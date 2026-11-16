import { CardCharacteristicService } from '@card-game/engine/engine/card-characteristic-service';
import { abilityEffects } from '@card-game/engine/engine/ability-effects';
import { describeTargetGroups } from '@card-game/engine/shared/target-legality';
import { selectModeEffects } from '@card-game/engine/shared/action-modes';
import type { CardInstance } from '@card-game/engine/types/card.types';
import type { GameRoom } from '@card-game/engine/types/game.room.types';
import { targetOptions } from '@card-game/engine/engine/choices';
import type { TargetPointer } from '@card-game/engine/types/effect.types';
import type { TargetGroupView } from '@card-game/protocol';
import { visibleTargetCards } from './reveal-policy';
import { publicAbilityId } from './wire-identifiers';

export function buildTargetGroups(room: GameRoom, viewerId: string, card: CardInstance, keys?: ReadonlySet<string>): Record<string, TargetGroupView[]> {
  const blueprint = CardCharacteristicService.resolveBlueprint(room, card);
  const visibleCards = new Set(visibleTargetCards(room, viewerId).map(target => target.uuid));
  const result: Record<string, TargetGroupView[]> = {};
  const canSelectOnBoard = (target: TargetPointer) => (!target.cardUuid || visibleCards.has(target.cardUuid)) &&
    (target.targetType !== 'card' || target.zone === 'battlefield');
  const sources = [
    { key: 'cast_spell', definition: blueprint, effects: blueprint.onCastEffects!, alternatives: blueprint.castRequirements.alternativeCosts },
    ...blueprint.abilities.filter(ability => ability.type === 'activated').map(ability => ({ key: 'activate_ability:' + publicAbilityId(room.roomId, viewerId, ability.id),
      definition: ability, effects: abilityEffects(ability), alternatives: ability.alternativeCosts })),
  ];
  for (const { key, definition, effects, alternatives } of sources) {
    if (keys && !keys.has(key)) continue;
    // These actions first ask the authoritative announcement machinery to choose
    // values/routes/modes. That machinery projects its own choice options.
    if (definition.numericDeclarations?.length || alternatives?.length || definition.modes?.length) continue;
    const selected = selectModeEffects(effects, undefined, undefined, undefined);
    if (!selected) continue;
    const groups = describeTargetGroups(selected).map(group => {
      const { type, required, minTargets, maxTargets } = group.targeting;
      const legalTargets = targetOptions(room, viewerId, card, group.targeting)
        .map(option => option.value as TargetPointer);
      return { id: group.id, targeting: { type, required, minTargets, maxTargets }, legalTargets };
    });
    // Use the live choice panel when the board has no interaction for a target.
    if (groups.every(group => group.legalTargets.every(canSelectOnBoard) &&
        group.legalTargets.length >= (group.targeting.minTargets ?? (group.targeting.required ? 1 : 0)))) result[key] = groups;
  }
  return result;
}
