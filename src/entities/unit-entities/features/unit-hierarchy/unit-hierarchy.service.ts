import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Sequelize } from 'sequelize-typescript';
import { UnitHierarchyRepository } from './unit-hierarchy.repository';
import { UnitHierarchyNode } from './unit-hierarchy.types';
import {
  getEmergencyUnitIds,
  getHierarchy,
  getStatusFromUnit,
} from './utilities/hierarchyRecursion';
import { UnitRelation } from '../../unit-relations/unit-relation.model';
import { RemoveUnitRelationDto } from './DTO/remove-unit-relation.dto';
import { AddUnitRelationDto } from './DTO/add-unit-relation.dto';
import { TransferUnitRelationDto } from './DTO/update-unit-relation.dto';
import {
  UNIT_LEVELS,
  MATKAL_UNIT_ID,
  MESSAGE_TYPES,
  UNIT_STATUSES,
} from '../../../../constants';
import { Unit } from '../../unit/unit.model';
import { UnitStatus } from '../../units-statuses/units-statuses.model';
import { UnitStatusRepository } from '../../units-statuses/units-statuses.repository';
import { ReportRoutingRepository } from '../../../report-entities/report/report-routing.repository';
import { formatDate } from '../../../../utils/date';
import { isDefined, isEmptyish } from 'remeda';
import { UserRepository } from '../../users/user.repository';

const DEFAULT_STATUS = { id: 0, description: 'בדיווח' };
const DATE_MISMATCH_ERROR = 'לא ניתן לבצע שינוי היררכי על ימים עברו';
const REMOVE_PARENT_LOCKED_ERROR = 'יחידה האב נעולה, אין אפשרות למחוק את הקשר';
const TRANSFER_PARENT_LOCKED_ERROR =
  'יחידה האב נעולה, אין אפשרות להעביר את הקשר';
const SELF_RELATION_ERROR = 'לא ניתן לקשר יחידה לעצמה';
const NOT_UNDER_ROOT_UNIT_ERROR = 'היחידה שניסית להעביר אינה תחתייך';
const LOWER_LEVEL_ERROR = 'לא ניתן להוסיף יחידה לרמה היררכית נמוכה ממנה';
const CREATE_UPPER_NOT_UNDER_ROOT_UNIT_ERROR =
  'היחידה אליה ניסית להוסיף קשר, אינה תחתייך';
const TRANSFER_UPPER_NOT_UNDER_ROOT_UNIT_ERROR =
  'היחידה אליה ניסית להעביר את הקשר, אינה תחתייך';
const LOWER_UNIT_HAS_ANOTHER_ACTIVE_RELATION_ERROR =
  'החידה שניסית להוסיף מקושרת ליחידה אחרת';
const RELATION_ALREADY_EXISTS_ERROR = 'הקשר כבר קיים';
const ADD_PARENT_LOCKED_ERROR = 'יחידת האב נעולה, אין אפשרות ליצור את הקשר';
const UNIT_COMBOBOX_RESULT_LIMIT = 20;
const LOWER_LEVEL_UNITS_RESULT_LIMIT = 10;

type SearchUnitsComboboxOptions = {
  filter: string;
  currentLevel: number;
  parentUnitId?: number;
};

type LowerLevelUnitsConnectionOptions = {
  filter?: string;
  limit?: number;
  offset?: number;
  isConnectedToRoot?: boolean;
};

type ActiveUnitRelationEdge = {
  unitId: number;
  relatedUnitId: number;
};

const buildConnectedUnitIds = (
  rootUnitId: number,
  relations: ActiveUnitRelationEdge[],
): Set<number> => {
  const childrenByParent = new Map<number, number[]>();

  for (const relation of relations) {
    const children = childrenByParent.get(relation.unitId) ?? [];
    children.push(relation.relatedUnitId);
    childrenByParent.set(relation.unitId, children);
  }

  const connectedUnitIds = new Set<number>();
  const queue = [...(childrenByParent.get(rootUnitId) ?? [])];

  while (queue.length > 0) {
    const unitId = queue.shift();
    if (unitId === undefined || connectedUnitIds.has(unitId)) continue;

    connectedUnitIds.add(unitId);
    queue.push(...(childrenByParent.get(unitId) ?? []));
  }

  return connectedUnitIds;
};

const normalizeLowerLevelLimit = (limit?: number): number => {
  if (limit === undefined || !Number.isInteger(limit) || limit <= 0) {
    return LOWER_LEVEL_UNITS_RESULT_LIMIT;
  }

  return Math.min(limit, LOWER_LEVEL_UNITS_RESULT_LIMIT);
};

const normalizeLowerLevelOffset = (offset?: number): number => {
  if (offset === undefined || !Number.isInteger(offset) || offset < 0) {
    return 0;
  }

  return offset;
};

const buildEmergencyUnitIds = (
  detailByUnit: Map<number, Unit>,
  relations: ActiveUnitRelationEdge[],
): Set<number> => {
  const emergencyUnitIds = new Set<number>();
  const parentIdsByChild = new Map<number, number[]>();
  const gdudUnitIds: number[] = [];

  for (const [unitId, detail] of detailByUnit) {
    if ((detail.unitLevelId ?? 0) === UNIT_LEVELS.GDUD) {
      emergencyUnitIds.add(unitId);
      gdudUnitIds.push(unitId);
    }
  }

  for (const relation of relations) {
    const parentIds = parentIdsByChild.get(relation.relatedUnitId) ?? [];
    parentIds.push(relation.unitId);
    parentIdsByChild.set(relation.relatedUnitId, parentIds);
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

@Injectable()
export class UnitHierarchyService {
  private readonly logger = new Logger(UnitHierarchyService.name);

  constructor(
    private readonly repository: UnitHierarchyRepository,
    private readonly sequelize: Sequelize,
    private readonly unitStatusTypesRepository: UnitStatusRepository,
    private readonly reportRoutingRepository: ReportRoutingRepository,
    private readonly unitUserRepository: UserRepository,
  ) {}

  async getHierarchyForUser(
    username: string,
    date: string,
  ): Promise<UnitHierarchyNode[]> {
    try {
      const userUnit = await this.unitUserRepository.fetchUnitUser(username);
      const rootUnit = userUnit?.dataValues.unitId;

      if (!isDefined(rootUnit)) {
        throw new BadGatewayException({
          message: 'אינך מקושר ליחידה ארגונית',
          type: 'Fatal',
        });
      }

      const units = await this.getAllUnitsWithParents(date, rootUnit);
      const rootNode = units.find((unit) => unit.id === rootUnit);

      if (!rootNode || isEmptyish(rootNode.description)) {
        throw new BadGatewayException({
          message: 'היחידה שאליה אתה מקושר לא קיימת, יש ליצור קשר עם התמיכה',
          type: 'Fatal',
        });
      }

      if (!units.some((unit) => unit.parent?.id === rootUnit)) {
        throw new BadGatewayException({
          message: 'אין היררכיה ליחידה הנתונה',
          type: 'Fatal',
        });
      }

      return units;
    } catch (error) {
      this.logger.error(
        'Failed to fetch hierarchy for user',
        error instanceof Error ? error.stack : String(error),
      );
      throw error;
    }
  }

  async getAllUnitsWithParents(date: string, connectedRootUnitId?: number) {
    const unitDetails = await this.repository.fetchAllActiveUnitDetails(date);
    if (unitDetails.length === 0) return [];

    const uniqueUnitIds = Array.from(
      new Set(unitDetails.map((detail) => detail.unitId)),
    );
    const [unitStatuses, directParentRelations] = await Promise.all([
      this.repository.fetchUnitStatusesForDate(date, uniqueUnitIds),
      this.repository.fetchDirectParentRelations(date, uniqueUnitIds),
    ]);

    const detailByUnit = new Map<number, Unit>();
    for (const detail of unitDetails) {
      if (!detailByUnit.has(detail.unitId)) {
        detailByUnit.set(detail.unitId, detail);
      }
    }

    const statusByUnit = new Map<number, UnitStatus>();
    for (const status of unitStatuses) {
      if (!statusByUnit.has(status.unitId)) {
        statusByUnit.set(status.unitId, status);
      }
    }

    const parentByChild = new Map<number, number>();
    for (const relation of directParentRelations) {
      if (!parentByChild.has(relation.relatedUnitId)) {
        parentByChild.set(relation.relatedUnitId, relation.unitId);
      }
    }

    const emergencyUnitIds = buildEmergencyUnitIds(detailByUnit, directParentRelations);
    const matkalConnectedUnitIds = new Set([
      MATKAL_UNIT_ID,
      ...buildConnectedUnitIds(MATKAL_UNIT_ID, directParentRelations),
    ]);
    const connectedUnitIds = connectedRootUnitId
      ? new Set([
          connectedRootUnitId,
          ...buildConnectedUnitIds(connectedRootUnitId, directParentRelations),
        ])
      : null;

    const units = uniqueUnitIds.map((unitId): UnitHierarchyNode => {
      const detail = detailByUnit.get(unitId);
      const status =
        statusByUnit.get(unitId)?.unitStatus?.dataValues ?? DEFAULT_STATUS;
      const parentId = parentByChild.get(unitId);

      const parent = parentId
        ? {
            id: parentId,
            description: detailByUnit.get(parentId)?.description ?? '',
            level: detailByUnit.get(parentId)?.unitLevelId ?? 0,
            simul: detailByUnit.get(parentId)?.tsavIrgunCodeId ?? '',
            status:
              statusByUnit.get(parentId)?.unitStatus?.dataValues ??
              DEFAULT_STATUS,
          }
        : null;

      return {
        id: unitId,
        description: detail?.description ?? '',
        level: detail?.unitLevelId ?? 0,
        simul: detail?.tsavIrgunCodeId ?? '',
        isEmergencyUnit: emergencyUnitIds.has(unitId),
        isConnectedToMatkal: matkalConnectedUnitIds.has(unitId),
        ...(connectedUnitIds
          ? {
              isConnectedToRoot: connectedUnitIds.has(unitId),
              isRootUnit: unitId === connectedRootUnitId,
            }
          : {}),
        status,
        parent,
      };
    });

    return units.sort((a, b) => {
      if (a.level !== b.level) return a.level - b.level;
      return a.id - b.id;
    });
  }

  async searchUnitsCombobox(
    date: string,
    { filter, currentLevel, parentUnitId }: SearchUnitsComboboxOptions,
  ) {
    if (!Number.isFinite(currentLevel)) return [];

    const unitDetails = await this.repository.fetchActiveUnitDetailsBySearch(
      date,
      {
        filter,
        currentLevel,
        limit: UNIT_COMBOBOX_RESULT_LIMIT,
      },
    );

    if (unitDetails.length === 0) return [];

    const uniqueUnitIds = Array.from(
      new Set(unitDetails.map((detail) => detail.unitId)),
    );
    const directParentRelations =
      await this.repository.fetchDirectParentRelations(date, uniqueUnitIds);
    const parentUnitIds = Array.from(
      new Set(directParentRelations.map((relation) => relation.unitId)),
    );
    const parentDetails = await this.repository.fetchActiveUnitDetailsByIds(
      date,
      parentUnitIds,
    );
    const unitStatuses = await this.repository.fetchUnitStatusesForDate(
      date,
      Array.from(new Set([...uniqueUnitIds, ...parentUnitIds])),
    );

    const detailByUnit = new Map<number, Unit>();
    for (const detail of [...unitDetails, ...parentDetails]) {
      if (!detailByUnit.has(detail.unitId)) {
        detailByUnit.set(detail.unitId, detail);
      }
    }

    const statusByUnit = new Map<number, UnitStatus>();
    for (const status of unitStatuses) {
      if (!statusByUnit.has(status.unitId)) {
        statusByUnit.set(status.unitId, status);
      }
    }

    const parentByChild = new Map<number, number>();
    for (const relation of directParentRelations) {
      if (!parentByChild.has(relation.relatedUnitId)) {
        parentByChild.set(relation.relatedUnitId, relation.unitId);
      }
    }

    return uniqueUnitIds
      .map((unitId): UnitHierarchyNode => {
        const detail = detailByUnit.get(unitId);
        const status =
          statusByUnit.get(unitId)?.unitStatus?.dataValues ?? DEFAULT_STATUS;
        const directParentId = parentByChild.get(unitId);
        const parentStatus = directParentId
          ? statusByUnit.get(directParentId)?.unitStatus?.dataValues ??
            DEFAULT_STATUS
          : DEFAULT_STATUS;
        const parent = directParentId
          ? {
              id: directParentId,
              description: detailByUnit.get(directParentId)?.description ?? '',
              level: detailByUnit.get(directParentId)?.unitLevelId ?? 0,
              simul: detailByUnit.get(directParentId)?.tsavIrgunCodeId ?? '',
              status: parentStatus,
            }
          : null;

        return {
          id: unitId,
          description: detail?.description ?? '',
          level: detail?.unitLevelId ?? 0,
          simul: detail?.tsavIrgunCodeId ?? '',
          isEmergencyUnit: false,
          status,
          parent,
        };
      })
      .filter(
        (unit) => parentUnitId === undefined || unit.parent?.id !== parentUnitId,
      )
      .sort((left, right) => {
        if (left.level !== right.level) return left.level - right.level;
        return left.id - right.id;
      });
  }

  async getLowerLevelUnitsConnection(
    date: string,
    screenUnitId: number,
    {
      filter = "",
      limit,
      offset,
      isConnectedToRoot,
    }: LowerLevelUnitsConnectionOptions = {},
  ): Promise<UnitHierarchyNode[]> {
    if (!Number.isInteger(screenUnitId) || screenUnitId <= 0) {
      throw new BadRequestException({
        message: 'Missing screen unit',
        type: MESSAGE_TYPES.FAILURE,
      });
    }

    const unitDetails = await this.repository.fetchAllActiveUnitDetails(date);
    if (unitDetails.length === 0) return [];

    const detailByUnit = new Map<number, Unit>();
    for (const detail of unitDetails) {
      if (!detailByUnit.has(detail.unitId)) {
        detailByUnit.set(detail.unitId, detail);
      }
    }

    const screenUnit = detailByUnit.get(screenUnitId);
    if (!screenUnit) {
      throw new BadRequestException({
        message: 'Screen unit does not exist for the selected date',
        type: MESSAGE_TYPES.FAILURE,
      });
    }

    const activeRelations = await this.repository.fetchDirectParentRelations(
      date,
      Array.from(detailByUnit.keys()),
    );
    const connectedUnitIds = buildConnectedUnitIds(
      screenUnitId,
      activeRelations,
    );
    const matkalConnectedUnitIds = new Set([
      MATKAL_UNIT_ID,
      ...buildConnectedUnitIds(MATKAL_UNIT_ID, activeRelations),
    ]);
    const parentByChild = new Map<number, number>();
    for (const relation of activeRelations) {
      if (!parentByChild.has(relation.relatedUnitId)) {
        parentByChild.set(relation.relatedUnitId, relation.unitId);
      }
    }

    const screenUnitLevel = screenUnit.unitLevelId ?? 0;
    const normalizedFilter = filter.trim().toLowerCase();
    const lowerUnitIds = Array.from(detailByUnit.keys())
      .filter((unitId) => {
        const detail = detailByUnit.get(unitId);
        const unitLevel = detail?.unitLevelId ?? 0;
        if (unitLevel <= screenUnitLevel) return false;

        const isConnected = connectedUnitIds.has(unitId);
        if (
          isConnectedToRoot !== undefined &&
          isConnected !== isConnectedToRoot
        ) {
          return false;
        }

        if (!normalizedFilter) return true;

        return [
          detail?.description ?? '',
          detail?.tsavIrgunCodeId ?? '',
          String(unitId),
        ].some((value) => value.toLowerCase().includes(normalizedFilter));
      })
      .sort((left, right) => {
        const leftLevel = detailByUnit.get(left)?.unitLevelId ?? 0;
        const rightLevel = detailByUnit.get(right)?.unitLevelId ?? 0;

        if (leftLevel !== rightLevel) return leftLevel - rightLevel;
        return left - right;
      });

    if (lowerUnitIds.length === 0) return [];

    const normalizedOffset = normalizeLowerLevelOffset(offset);
    const pagedUnitIds = lowerUnitIds.slice(
      normalizedOffset,
      normalizedOffset + normalizeLowerLevelLimit(limit),
    );

    if (pagedUnitIds.length === 0) return [];

    const parentUnitIds = pagedUnitIds
      .map((unitId) => parentByChild.get(unitId))
      .filter((unitId): unitId is number => unitId !== undefined);
    const unitStatuses = await this.repository.fetchUnitStatusesForDate(
      date,
      Array.from(new Set([...pagedUnitIds, ...parentUnitIds])),
    );
    const statusByUnit = new Map<number, UnitStatus>();
    for (const status of unitStatuses) {
      if (!statusByUnit.has(status.unitId)) {
        statusByUnit.set(status.unitId, status);
      }
    }

    const emergencyUnitIds = buildEmergencyUnitIds(detailByUnit, activeRelations);

    return pagedUnitIds.map((unitId): UnitHierarchyNode => {
      const detail = detailByUnit.get(unitId);
      const status =
        statusByUnit.get(unitId)?.unitStatus?.dataValues ?? DEFAULT_STATUS;
      const parentId = parentByChild.get(unitId);
      const parent = parentId
        ? {
            id: parentId,
            description: detailByUnit.get(parentId)?.description ?? '',
            level: detailByUnit.get(parentId)?.unitLevelId ?? 0,
            simul: detailByUnit.get(parentId)?.tsavIrgunCodeId ?? '',
            status:
              statusByUnit.get(parentId)?.unitStatus?.dataValues ??
              DEFAULT_STATUS,
          }
        : null;

      return {
        id: unitId,
        description: detail?.description ?? '',
        level: detail?.unitLevelId ?? 0,
        simul: detail?.tsavIrgunCodeId ?? '',
        isConnectedToRoot: connectedUnitIds.has(unitId),
        isConnectedToMatkal: matkalConnectedUnitIds.has(unitId),
        isEmergencyUnit: emergencyUnitIds.has(unitId),
        status,
        parent,
      };
    });
  }

  async removeUnitRelation(
    removeUnitRelationDto: RemoveUnitRelationDto,
    date: string,
  ) {
    const { formattedDate } = formatDate(new Date());

    if (date !== formattedDate) {
      throw new BadRequestException({
        message: DATE_MISMATCH_ERROR,
        type: MESSAGE_TYPES.FAILURE,
      });
    }

    const { lowerUnit, upperUnit } = removeUnitRelationDto;
    const transaction = await this.sequelize.transaction();

    try {
      if (removeUnitRelationDto.rootUnit !== null) {
        const isUnderRootUnit = await this.repository.isUnitUnderRootUnit(
          formattedDate,
          removeUnitRelationDto.rootUnit,
          lowerUnit,
          transaction,
        );

        if (!isUnderRootUnit) {
          throw new BadRequestException({
            message: NOT_UNDER_ROOT_UNIT_ERROR,
            type: MESSAGE_TYPES.FAILURE,
          });
        }
      }

      const activeRelation = await this.repository.fetchCurrentParentRelation(
        lowerUnit,
        formattedDate,
        transaction,
      );

      if (!activeRelation || activeRelation.unitId !== upperUnit) {
        throw new BadRequestException({
          message: `היחידה ${lowerUnit} כבר לא מקושרת אל היחידה ${upperUnit} יש לרענן את המסך`,
          type: MESSAGE_TYPES.FAILURE,
        });
      }

      const parentUnitStatus = await this.repository.fetchUnitStatusForDate(
        activeRelation.unitId,
        formattedDate,
        transaction,
      );
      const parentStatusId =
        parentUnitStatus?.unitStatusId ?? UNIT_STATUSES.REQUESTING;

      if (parentStatusId !== UNIT_STATUSES.REQUESTING) {
        throw new BadRequestException({
          message: REMOVE_PARENT_LOCKED_ERROR,
          type: MESSAGE_TYPES.FAILURE,
        });
      }

      const hierarchyUnitIds =
        await this.unitStatusTypesRepository.fetchHierarchyUnitIds(
          formattedDate,
          [lowerUnit],
          transaction,
        );
      await this.unitStatusTypesRepository.clearStatusesForUnitsDate(
        hierarchyUnitIds,
        formattedDate,
        transaction,
      );

      await this.repository.closeRelationOnDate(
        activeRelation,
        formattedDate,
        transaction,
      );
      await this.reportRoutingRepository.rerouteUnitReportsToParentForDate(
        lowerUnit,
        formattedDate,
        null,
        null,
        null,
        transaction,
      );

      await transaction.commit();
      return {
        message: 'הקשר ההיררכי הוסר בהצלחה',
        type: MESSAGE_TYPES.SUCCESS,
      };
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  async addUnitRelation(
    addUnitRelationDto: AddUnitRelationDto,
    date: string,
    username: string,
  ) {
    const { formattedDate } = formatDate(new Date());

    if (date !== formattedDate) {
      throw new BadRequestException({
        message: DATE_MISMATCH_ERROR,
        type: MESSAGE_TYPES.FAILURE,
      });
    }

    const { lowerUnit, upperUnit } = addUnitRelationDto;
    if (lowerUnit === upperUnit) {
      throw new BadRequestException({
        message: SELF_RELATION_ERROR,
        type: MESSAGE_TYPES.FAILURE,
      });
    }

    const transaction = await this.sequelize.transaction();

    try {
      if (addUnitRelationDto.rootUnit === null) {
        throw new BadRequestException({
          message: CREATE_UPPER_NOT_UNDER_ROOT_UNIT_ERROR,
          type: MESSAGE_TYPES.FAILURE,
        });
      }

      const isUpperUnitUnderRootUnit =
        await this.repository.isUnitUnderRootUnit(
          formattedDate,
          addUnitRelationDto.rootUnit,
          upperUnit,
          transaction,
        );

      if (!isUpperUnitUnderRootUnit) {
        throw new BadRequestException({
          message: CREATE_UPPER_NOT_UNDER_ROOT_UNIT_ERROR,
          type: MESSAGE_TYPES.FAILURE,
        });
      }

      const activeRelation = await this.repository.fetchCurrentParentRelation(
        lowerUnit,
        formattedDate,
        transaction,
      );

      if (activeRelation?.unitId === upperUnit) {
        throw new BadRequestException({
          message: RELATION_ALREADY_EXISTS_ERROR,
          type: MESSAGE_TYPES.FAILURE,
        });
      }

      const hasOpenRelationWithAnotherUnit =
        !!activeRelation &&
        activeRelation.unitId !== upperUnit &&
        activeRelation.endDate instanceof Date &&
        activeRelation.endDate.getUTCFullYear() === 9999;

      if (hasOpenRelationWithAnotherUnit) {
        throw new BadRequestException({
          message: LOWER_UNIT_HAS_ANOTHER_ACTIVE_RELATION_ERROR,
          type: MESSAGE_TYPES.FAILURE,
        });
      }

      const parentUnitStatus = await this.repository.fetchUnitStatusForDate(
        upperUnit,
        formattedDate,
        transaction,
      );
      const parentStatusId =
        parentUnitStatus?.unitStatusId ?? UNIT_STATUSES.REQUESTING;

      if (parentStatusId !== UNIT_STATUSES.REQUESTING) {
        throw new BadRequestException({
          message: ADD_PARENT_LOCKED_ERROR,
          type: MESSAGE_TYPES.FAILURE,
        });
      }

      const details = await this.repository.fetchUnitsActiveDetails(
        formattedDate,
        [upperUnit, lowerUnit],
        transaction,
      );

      const detailsByUnit = new Map<number, number>();
      for (const detail of details) {
        if (!detailsByUnit.has(detail.unitId)) {
          detailsByUnit.set(detail.unitId, detail.unitLevelId);
        }
      }

      const upperUnitLevel = detailsByUnit.get(upperUnit) ?? 0;
      const lowerUnitLevel = detailsByUnit.get(lowerUnit) ?? 0;

      if (upperUnitLevel > lowerUnitLevel) {
        throw new BadRequestException({
          message: LOWER_LEVEL_ERROR,
          type: MESSAGE_TYPES.FAILURE,
        });
      }

      if (activeRelation) {
        await this.repository.closeRelationOnDate(
          activeRelation,
          formattedDate,
          transaction,
        );
      }

      await this.repository.createParentRelation(
        upperUnit,
        lowerUnit,
        formattedDate,
        transaction,
      );

      await this.reportRoutingRepository.rerouteUnitReportsToParentForDate(
        lowerUnit,
        formattedDate,
        upperUnit,
        addUnitRelationDto.rootUnit,
        username,
        transaction,
      );

      await transaction.commit();
      return {
        message: 'הקשר ההיררכי נוסף בהצלחה',
        type: MESSAGE_TYPES.SUCCESS,
      };
    } catch (error) {
      this.logger.error(
        'Failed to add unit relation',
        error instanceof Error ? error.stack : String(error),
      );
      await transaction.rollback();
      throw error;
    }
  }

  async transferUnitRelation(
    transferUnitRelationDto: TransferUnitRelationDto,
    date: string,
    username: string,
  ) {
    const { formattedDate } = formatDate(new Date());

    if (date !== formattedDate) {
      throw new BadRequestException({
        message: DATE_MISMATCH_ERROR,
        type: MESSAGE_TYPES.FAILURE,
      });
    }

    const { lowerUnit, upperUnit } = transferUnitRelationDto;
    if (lowerUnit === upperUnit) {
      throw new BadRequestException({
        message: SELF_RELATION_ERROR,
        type: MESSAGE_TYPES.FAILURE,
      });
    }

    const transaction = await this.sequelize.transaction();

    try {
      const [isLowerUnderRootUnit, isUpperUnitUnderRootUnit] =
        await Promise.all([
          this.repository.isUnitUnderRootUnit(
            formattedDate,
            transferUnitRelationDto.rootUnit,
            lowerUnit,
            transaction,
          ),
          this.repository.isUnitUnderRootUnit(
            formattedDate,
            transferUnitRelationDto.rootUnit,
            upperUnit,
            transaction,
          ),
        ]);

      const isLowerUnitUnderMatkal = await this.repository.isUnitUnderRootUnit(
        formattedDate,
        MATKAL_UNIT_ID,
        lowerUnit,
        transaction,
      );

      if (!isLowerUnderRootUnit && isLowerUnitUnderMatkal) {
        throw new BadRequestException({
          message: NOT_UNDER_ROOT_UNIT_ERROR,
          type: MESSAGE_TYPES.FAILURE,
        });
      }

      if (!isUpperUnitUnderRootUnit) {
        throw new BadRequestException({
          message: TRANSFER_UPPER_NOT_UNDER_ROOT_UNIT_ERROR,
          type: MESSAGE_TYPES.FAILURE,
        });
      }

      const activeRelation = await this.repository.fetchCurrentParentRelation(
        lowerUnit,
        formattedDate,
        transaction,
      );

      if (activeRelation?.unitId === upperUnit) {
        throw new BadRequestException({
          message: RELATION_ALREADY_EXISTS_ERROR,
          type: MESSAGE_TYPES.FAILURE,
        });
      }

      if (activeRelation) {
        const currentParentUnitStatus =
          await this.repository.fetchUnitStatusForDate(
            activeRelation.unitId,
            formattedDate,
            transaction,
          );
        const currentParentStatusId =
          currentParentUnitStatus?.unitStatusId ?? UNIT_STATUSES.REQUESTING;

        if (currentParentStatusId !== UNIT_STATUSES.REQUESTING) {
          throw new BadRequestException({
            message: TRANSFER_PARENT_LOCKED_ERROR,
            type: MESSAGE_TYPES.FAILURE,
          });
        }
      }

      const parentUnitStatus = await this.repository.fetchUnitStatusForDate(
        upperUnit,
        formattedDate,
        transaction,
      );
      const parentStatusId =
        parentUnitStatus?.unitStatusId ?? UNIT_STATUSES.REQUESTING;

      if (parentStatusId !== UNIT_STATUSES.REQUESTING) {
        throw new BadRequestException({
          message: ADD_PARENT_LOCKED_ERROR,
          type: MESSAGE_TYPES.FAILURE,
        });
      }

      const details = await this.repository.fetchUnitsActiveDetails(
        formattedDate,
        [upperUnit, lowerUnit],
        transaction,
      );

      const detailsByUnit = new Map<number, number>();
      for (const detail of details) {
        if (!detailsByUnit.has(detail.unitId)) {
          detailsByUnit.set(detail.unitId, detail.unitLevelId);
        }
      }

      const upperUnitLevel = detailsByUnit.get(upperUnit) ?? 0;
      const lowerUnitLevel = detailsByUnit.get(lowerUnit) ?? 0;

      if (upperUnitLevel > lowerUnitLevel) {
        throw new BadRequestException({
          message: LOWER_LEVEL_ERROR,
          type: MESSAGE_TYPES.FAILURE,
        });
      }

      if (activeRelation) {
        await this.repository.closeRelationOnDate(
          activeRelation,
          formattedDate,
          transaction,
        );
      }

      await this.repository.createParentRelation(
        upperUnit,
        lowerUnit,
        formattedDate,
        transaction,
      );

      const hierarchyUnitIds =
        await this.unitStatusTypesRepository.fetchHierarchyUnitIds(
          formattedDate,
          [lowerUnit],
          transaction,
        );
      await this.unitStatusTypesRepository.clearStatusesForUnitsDate(
        hierarchyUnitIds,
        formattedDate,
        transaction,
      );

      await this.reportRoutingRepository.rerouteUnitReportsToParentForDate(
        lowerUnit,
        formattedDate,
        upperUnit,
        transferUnitRelationDto.rootUnit,
        username,
        transaction,
      );

      await transaction.commit();
      return {
        message: 'הקשר ההיררכי הועבר בהצלחה',
        type: MESSAGE_TYPES.SUCCESS,
      };
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  async getNestedHierarchyByRootUnit(rootUnit: Number, date: string) {
    const allRelations = (await this.repository.fetchActive(
      date,
    )) as UnitRelation[];
    const emergencyUnitIds = getEmergencyUnitIds(allRelations);

    const rootChildren = allRelations.filter(
      (relation) => relation?.dataValues?.unitId === Number(rootUnit),
    );

    return rootChildren.map((childRelation) => {
      const childId = childRelation?.dataValues?.relatedUnitId;
      const childDetail = childRelation?.relatedUnit?.activeDetail?.dataValues;

      const childHierarchy = allRelations.filter(
        (relation) => relation?.dataValues?.unitId === childId,
      );

      const hierarchy = getHierarchy(
        allRelations,
        childHierarchy,
        emergencyUnitIds,
      );

      return {
        id: childId,
        description: childDetail?.description ?? '',
        level: childDetail?.unitLevelId ?? 0,
        simul: childDetail?.tsavIrgunCodeId ?? '',
        isEmergencyUnit: emergencyUnitIds.has(childId),
        status: getStatusFromUnit(childRelation?.relatedUnit),
        children: hierarchy.map((childRelatedUnit) => {
          const { parent, ...children } = childRelatedUnit;
          return {
            ...children,
            status: childRelatedUnit.status ?? DEFAULT_STATUS,
          };
        }),
      };
    });
  }

  async fetchLowerUnits(date: string, unitId: number) {
    return await this.repository.fetchActive(date, unitId);
  }

  async fetchActiveRelations(date: string): Promise<UnitRelation[]> {
    return this.repository.fetchActive(date) as Promise<UnitRelation[]>;
  }

  fetchUnitStatusForDate(unitId: number, date: string) {
    return this.repository.fetchUnitStatusForDate(unitId, date);
  }

  buildEmergencyUnitLookup(relations: UnitRelation[]): Record<number, boolean> {
    const lookup: Record<number, boolean> = {};
    for (const unitId of getEmergencyUnitIds(relations)) {
      lookup[unitId] = true;
    }

    return lookup;
  }
}
