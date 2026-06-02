import { UnitRelation } from '../../../unit-relations/unit-relation.model';
import { UnitHierarchyNode, UnitStatus } from '../unit-hierarchy.types';
import { UNIT_LEVELS } from '../../../../../constants';

const DEFAULT_STATUS = { id: 0, description: 'בדיווח' };

export const getStatusFromUnit = (
  unit?: {
    unitStatus?: Array<{
      unitStatus?: { id: number; description: string; dataValues?: UnitStatus };
    }>;
  } | null,
): UnitStatus => {
  const status = unit?.unitStatus?.[0]?.unitStatus;
  return (
    status?.dataValues ??
    (status
      ? { id: status.id, description: status.description }
      : DEFAULT_STATUS)
  );
};

export const getEmergencyUnitIds = (unitRelations: UnitRelation[]) => {
  const emergencyUnitIds = new Set<number>();
  const parentIdsByChild = new Map<number, number[]>();
  const gdudUnitIds: number[] = [];

  for (const relation of unitRelations) {
    const parentId = relation?.dataValues?.unitId;
    const childId = relation?.dataValues?.relatedUnitId;
    const childLevel =
      relation?.relatedUnit?.activeDetail?.dataValues?.unitLevelId ?? 0;

    if (!childId) continue;

    if (childLevel === UNIT_LEVELS.GDUD) {
      emergencyUnitIds.add(childId);
      gdudUnitIds.push(childId);
    }

    if (parentId) {
      const parentIds = parentIdsByChild.get(childId) ?? [];
      parentIds.push(parentId);
      parentIdsByChild.set(childId, parentIds);
    }
  }

  const queue = [...gdudUnitIds];
  while (queue.length > 0) {
    const childId = queue.shift();
    if (!childId) continue;

    const parentIds = parentIdsByChild.get(childId) ?? [];
    for (const parentId of parentIds) {
      if (emergencyUnitIds.has(parentId)) continue;
      emergencyUnitIds.add(parentId);
      queue.push(parentId);
    }
  }

  return emergencyUnitIds;
};

export const getRootUnit = (
  unitRelations: UnitRelation[],
  unitId: number,
  emergencyUnitIds: Set<number> = getEmergencyUnitIds(unitRelations),
): UnitHierarchyNode | null => {
  const relation = unitRelations.find(
    (rel) => rel?.dataValues?.unitId === unitId,
  );

  const unit = relation?.unit?.activeDetail?.dataValues;

  return {
    id: unitId,
    description: unit?.description ?? '',
    level: unit?.unitLevelId ?? 0,
    simul: unit?.tsavIrgunCodeId ?? '',
    isEmergencyUnit: emergencyUnitIds.has(unitId),
    isConnectedToRoot: true,
    status: getStatusFromUnit(relation?.unit),
    parent: null,
  };
};

const getUnit = (
  relation: UnitRelation,
  emergencyUnitIds: Set<number>,
): UnitHierarchyNode => {
  const unit = relation?.relatedUnit?.activeDetail?.dataValues;
  const parentUnit = relation?.unit?.activeDetail?.dataValues;
  const unitId = unit?.unitId ?? 0;

  return {
    description: unit?.description ?? '',
    id: unitId,
    level: unit?.unitLevelId ?? 0,
    simul: unit?.tsavIrgunCodeId ?? '',
    isEmergencyUnit: emergencyUnitIds.has(unitId),
    isConnectedToRoot: true,
    status: getStatusFromUnit(relation?.relatedUnit),
    parent: {
      description: parentUnit?.description ?? '',
      id: parentUnit?.unitId ?? 0,
      level: parentUnit?.unitLevelId ?? 0,
      simul: parentUnit?.tsavIrgunCodeId ?? '',
      status: getStatusFromUnit(relation?.unit),
    },
  };
};

export const getHierarchy = (
  unitsRelations: UnitRelation[],
  unitsChildren: UnitRelation[],
  emergencyUnitIds: Set<number> = getEmergencyUnitIds(unitsRelations),
) => {
  const visited = new Set<number>();
  const childrenByParent = new Map<number, UnitRelation[]>();

  for (const relation of unitsRelations) {
    const parentId = relation?.dataValues?.unitId;
    const siblings = childrenByParent.get(parentId) ?? [];
    siblings.push(relation);
    childrenByParent.set(parentId, siblings);
  }

  const buildHierarchy = (relations: UnitRelation[]): UnitHierarchyNode[] => {
    const units: UnitHierarchyNode[] = [];

    for (const relation of relations) {
      const childId = relation?.dataValues?.relatedUnitId;
      if (!childId || visited.has(childId)) continue;

      visited.add(childId);
      units.push(getUnit(relation, emergencyUnitIds));

      const descendants = childrenByParent.get(childId);
      if (descendants?.length) {
        units.push(...buildHierarchy(descendants));
      }
    }

    return units;
  };

  return buildHierarchy(unitsChildren);
};
