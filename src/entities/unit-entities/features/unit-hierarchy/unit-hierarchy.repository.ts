import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/sequelize";
import { isDefined } from "remeda";
import { Op, Sequelize, Transaction } from "sequelize";
import { OBJECT_TYPES, UNIT_LEVELS, UNIT_RELATION_TYPES } from "../../../../constants";
import { UnitId } from "../../unit-id/unit-id.model";
import { UnitRelation } from "../../unit-relations/unit-relation.model";
import { UnitStatusType } from "../../unit-status-type/unit-status-type.model";
import { getReportableUnitTypeWhere } from "../../unit/unit-query.utils";
import { Unit } from "../../unit/unit.model";
import { UnitStatus } from "../../units-statuses/units-statuses.model";

export type UnitRelationEdge = {
  unitId: number;
  relatedUnitId: number;
};

export type UnitDirectParentRelation = {
  unitId: number;
  relatedUnitId: number;
};

export type UnitDetailSnapshot = {
  unitId: number;
  description: string | null;
  level: number | null;
  simul: string | null;
};

export type UnitStatusSnapshot = {
  id: number;
  description: string;
};

export type UnitLookupRow = {
  unitId: number;
  description: string | null;
  unitLevelId: number | null;
  simul: string | null;
  statusId: number;
  statusDescription: string;
};

@Injectable()
export class UnitHierarchyRepository {
  constructor(
    @InjectModel(UnitRelation) private readonly unitRelationModel: typeof UnitRelation,
    @InjectModel(UnitStatus) private readonly unitStatusTypesModel: typeof UnitStatus,
    @InjectModel(Unit) private readonly unitDetailModel: typeof Unit,
  ) { }

  fetchActive(date: string, unitId?: number) {
    const unitRelationWhereClause = {};

    if (isDefined(unitId)) {
      unitRelationWhereClause['unitId'] = unitId
    };

    return this.unitRelationModel.findAll({
      include: [{
        attributes: ['id'],
        model: UnitId,
        as: 'unit',
        required: true,
        include: [{
          attributes: ['unitStatusId'],
          model: UnitStatus,
          as: 'unitStatus',
          required: false,
          include: [{
            model: UnitStatusType,
            as: "unitStatus",
          }],
          where: {
            date,
          }
        },
        {
          attributes: ["unitId", "description", "tsavIrgunCodeId", "unitLevelId"],
          model: Unit,
          where: {
            objectType: OBJECT_TYPES.UNIT,
            ...getReportableUnitTypeWhere(),
          }
        }]
      },
      {
        attributes: ['id'],
        model: UnitId,
        as: 'relatedUnit',
        required: true,
        include: [{
          attributes: ['unitStatusId'],
          model: UnitStatus,
          as: 'unitStatus',
          required: false,
          include: [{
            model: UnitStatusType,
            as: "unitStatus",
          }],
          where: {
            date,
          }
        },
        {
          attributes: ["unitId", "description", "tsavIrgunCodeId", "unitLevelId"],
          model: Unit,
          where: {
            objectType: OBJECT_TYPES.UNIT,
            ...getReportableUnitTypeWhere(),
          }
        }]
      }],
      where: {
        ...unitRelationWhereClause,
        unitRelationId: UNIT_RELATION_TYPES.ZRA,
        unitObjectType: OBJECT_TYPES.UNIT,
        relatedUnitObjectType: OBJECT_TYPES.UNIT,
        startDate: { [Op.lte]: date },
        endDate: { [Op.gt]: date }
      }
    })
  }

  fetchAllActiveUnitDetails(date: string) {
    return this.unitDetailModel.findAll({
      attributes: ["unitId", "description", "tsavIrgunCodeId", "unitLevelId"],
      where: {
        startDate: { [Op.lte]: date },
        endDate: { [Op.gt]: date },
        objectType: [OBJECT_TYPES.UNIT, OBJECT_TYPES.COMPANY],
        ...getReportableUnitTypeWhere(),
      },
      order: [["startDate", "DESC"]],
    });
  }

  fetchActiveUnitDetailsByIds(date: string, unitIds: number[]) {
    if (unitIds.length === 0) return Promise.resolve([]);

    return this.unitDetailModel.findAll({
      attributes: ["unitId", "description", "tsavIrgunCodeId", "unitLevelId"],
      where: {
        unitId: { [Op.in]: unitIds },
        startDate: { [Op.lte]: date },
        endDate: { [Op.gt]: date },
        objectType: OBJECT_TYPES.UNIT,
        ...getReportableUnitTypeWhere(),
      },
      order: [["startDate", "DESC"]],
    });
  }

  fetchActiveUnitDetailsBySearch(
    date: string,
    {
      filter = "",
      currentLevel,
      limit,
    }: {
      filter?: string;
      currentLevel: number;
      limit: number;
    },
  ) {
    const normalizedFilter = filter.trim();
    const where = {
      startDate: { [Op.lte]: date },
      endDate: { [Op.gt]: date },
      objectType: OBJECT_TYPES.UNIT,
      unitLevelId: { [Op.gt]: currentLevel },
      [Op.and]: [
        {
          ...getReportableUnitTypeWhere(),
        },
        {
          ...(normalizedFilter
            ? {
              [Op.or]: [
                { description: { [Op.iLike]: `%${normalizedFilter}%` } },
                { tsavIrgunCodeId: { [Op.iLike]: `%${normalizedFilter}%` } },
                Sequelize.where(
                  Sequelize.cast(Sequelize.col("unit_id"), "TEXT"),
                  { [Op.iLike]: `%${normalizedFilter}%` },
                ),
              ],
            }
            : {}),
        }]
    };

    return this.unitDetailModel.findAll({
      attributes: ["unitId", "description", "tsavIrgunCodeId", "unitLevelId"],
      where,
      order: [
        ["unitLevelId", "ASC"],
        ["unitId", "ASC"],
        ["startDate", "DESC"],
      ],
      limit,
    });
  }

  async fetchUnitsForExcelImport(
    date: string,
    {
      unitIds = [],
      unitSimuls = [],
    }: {
      unitIds?: number[];
      unitSimuls?: string[];
    }
  ): Promise<UnitLookupRow[]> {
    if (unitIds.length === 0 && unitSimuls.length === 0) return [];

    const unitDetails = await this.unitDetailModel.findAll({
      attributes: ["unitId", "description", "tsavIrgunCodeId", "unitLevelId"],
      where: {
        startDate: { [Op.lte]: date },
        endDate: { [Op.gt]: date },
        objectType: OBJECT_TYPES.UNIT,
        ...getReportableUnitTypeWhere(),
        [Op.or]: [
          ...(unitIds.length > 0 ? [{ unitId: { [Op.in]: unitIds } }] : []),
          ...(unitSimuls.length > 0 ? [{ tsavIrgunCodeId: { [Op.in]: unitSimuls } }] : []),
        ]
      },
      order: [["startDate", "DESC"]],
    });

    if (unitDetails.length === 0) return [];

    const uniqueUnitIds = Array.from(new Set(unitDetails.map((detail) => detail.unitId)));
    const unitStatuses = await this.fetchUnitStatusesForDate(date, uniqueUnitIds);

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

    return uniqueUnitIds.map((unitId) => {
      const detail = detailByUnit.get(unitId);
      const status = statusByUnit.get(unitId)?.unitStatus;

      return {
        unitId,
        description: detail?.description ?? null,
        unitLevelId: detail?.unitLevelId ?? null,
        simul: detail?.tsavIrgunCodeId ?? null,
        statusId: status?.id ?? 0,
        statusDescription: status?.description ?? "",
      };
    });
  }

  fetchUnitStatusesForDate(date: string, unitIds: number[]) {
    if (unitIds.length === 0) return Promise.resolve([]);

    return this.unitStatusTypesModel.findAll({
      attributes: ["unitId", "unitStatusId", "date"],
      where: {
        unitId: { [Op.in]: unitIds },
        date,
      },
      include: [{
        model: UnitStatusType,
        as: "unitStatus",
      }],
      order: [["date", "DESC"]],
    });
  }

  fetchDirectParentRelations(date: string, childUnitIds: number[]) {
    if (childUnitIds.length === 0) return Promise.resolve([]);

    return this.unitRelationModel.findAll({
      attributes: ["unitId", "relatedUnitId"],
      where: {
        unitRelationId: UNIT_RELATION_TYPES.ZRA,
        unitObjectType: OBJECT_TYPES.UNIT,
        relatedUnitObjectType: { [Op.in]: [OBJECT_TYPES.UNIT, OBJECT_TYPES.COMPANY] },
        relatedUnitId: { [Op.in]: childUnitIds },
        startDate: { [Op.lte]: date },
        endDate: { [Op.gt]: date },
      },
      order: [["startDate", "DESC"]],
    });
  }

  async isUnitUnderRootUnit(
    date: string,
    rootUnitId: number,
    lowerUnitId: number,
    transaction?: Transaction
  ) {
    if (rootUnitId === lowerUnitId) return true;

    const visited = new Set<number>([rootUnitId]);
    let frontier = [rootUnitId];

    while (frontier.length > 0) {
      const relations = await this.unitRelationModel.findAll({
        attributes: ["unitId", "relatedUnitId"],
        where: {
          unitRelationId: UNIT_RELATION_TYPES.ZRA,
          unitObjectType: OBJECT_TYPES.UNIT,
          relatedUnitObjectType: OBJECT_TYPES.UNIT,
          unitId: { [Op.in]: frontier },
          startDate: { [Op.lte]: date },
          endDate: { [Op.gt]: date },
        },
        transaction,
      });

      const next: number[] = [];
      for (const relation of relations) {
        const childId = relation.relatedUnitId;
        if (childId === lowerUnitId) return true;
        if (visited.has(childId)) continue;

        visited.add(childId);
        next.push(childId);
      }

      frontier = next;
    }

    return false;
  }

  fetchUnitsActiveDetails(date: string, unitIds: number[], transaction?: Transaction) {
    if (unitIds.length === 0) return Promise.resolve([]);

    return this.unitDetailModel.findAll({
      attributes: ["unitId", "objectType", "unitLevelId"],
      where: {
        unitId: { [Op.in]: unitIds },
        objectType: OBJECT_TYPES.UNIT,
        startDate: { [Op.lte]: date },
        endDate: { [Op.gt]: date },
        ...getReportableUnitTypeWhere(),
      },
      order: [["startDate", "DESC"]],
      transaction,
    });
  }

  createParentRelation(
    upperUnit: number,
    lowerUnit: number,
    date: string,
    transaction?: Transaction
  ) {
    return this.unitRelationModel.upsert({
      unitId: upperUnit,
      relatedUnitId: lowerUnit,
      unitRelationId: UNIT_RELATION_TYPES.ZRA,
      unitObjectType: OBJECT_TYPES.UNIT,
      relatedUnitObjectType: OBJECT_TYPES.UNIT,
      startDate: new Date(date),
      endDate: new Date("9999-12-31"),
    }, { transaction });
  }

  fetchCurrentParentRelation(
    lowerUnit: number,
    date: string,
    transaction?: Transaction
  ) {
    return this.unitRelationModel.findOne({
      where: {
        unitRelationId: UNIT_RELATION_TYPES.ZRA,
        unitObjectType: OBJECT_TYPES.UNIT,
        relatedUnitObjectType: OBJECT_TYPES.UNIT,
        relatedUnitId: lowerUnit,
        startDate: { [Op.lte]: date },
        endDate: { [Op.gt]: date },
      },
      order: [["startDate", "DESC"]],
      transaction,
    });
  }

  fetchUnitStatusForDate(
    unitId: number,
    date: string,
    transaction?: Transaction
  ) {
    return this.unitStatusTypesModel.findOne({
      attributes: ["unitStatusId"],
      where: {
        unitId,
        date,
      },
      order: [["date", "DESC"]],
      transaction,
    });
  }

  closeRelationOnDate(
    relation: UnitRelation,
    date: string,
    transaction?: Transaction
  ) {
    return relation.update(
      {
        endDate: new Date(date),
      },
      { transaction }
    );
  }
}
