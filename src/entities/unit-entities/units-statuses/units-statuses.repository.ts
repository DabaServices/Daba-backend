import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/sequelize";
import { Op } from "sequelize";
import { Transaction } from "sequelize";
import { OBJECT_TYPES, RECORD_STATUS, REPORT_TYPES, UNIT_LEVELS, UNIT_RELATION_TYPES } from "../../../constants";
import { ReportItem } from "../../report-entities/report-item/report-item.model";
import { Report } from "../../report-entities/report/report.model";
import { UnitRelation } from "../unit-relations/unit-relation.model";
import { getReportableUnitTypeWhere } from "../unit/unit-query.utils";
import { Unit } from "../unit/unit.model";
import { IUnitStatus, UnitStatus } from "./units-statuses.model";

@Injectable()
export class UnitStatusRepository {
    constructor(
        @InjectModel(UnitStatus) private readonly unitStatusModel: typeof UnitStatus,
        @InjectModel(UnitRelation) private readonly unitRelationModel: typeof UnitRelation,
        @InjectModel(Unit) private readonly unitModel: typeof Unit,
        @InjectModel(Report) private readonly reportModel: typeof Report,
        @InjectModel(ReportItem) private readonly reportItemModel: typeof ReportItem,
    ) { }

    async fetchHierarchyUnitIds(date: string, unitIds: number[], transaction?: Transaction) {
        const rootUnitIds = [...new Set(unitIds)];
        if (rootUnitIds.length === 0) return [];

        const now = new Date(date);
        const visited = new Set<number>(rootUnitIds);
        const hierarchyUnitIds = [...rootUnitIds];

        let frontier = rootUnitIds;
        while (frontier.length > 0) {
            const relations = await this.unitRelationModel.findAll({
                attributes: ["relatedUnitId"],
                where: {
                    unitRelationId: UNIT_RELATION_TYPES.ZRA,
                    unitObjectType: OBJECT_TYPES.UNIT,
                    relatedUnitObjectType: { [Op.in]: [OBJECT_TYPES.UNIT, OBJECT_TYPES.COMPANY] },
                    unitId: { [Op.in]: frontier },
                    startDate: { [Op.lte]: now },
                    endDate: { [Op.gte]: now }
                },
                transaction,
            });

            const next: number[] = [];
            for (const relation of relations) {
                const childId = relation.relatedUnitId;
                if (visited.has(childId)) continue;

                visited.add(childId);
                hierarchyUnitIds.push(childId);
                next.push(childId);
            }

            frontier = next;
        }

        return hierarchyUnitIds;
    }

    updateStatuses(unitsStatuses: IUnitStatus[], transaction?: Transaction) {
        return this.unitStatusModel.bulkCreate(unitsStatuses, {
            updateOnDuplicate: ['unitStatusId'],
            transaction
        })
    }

    async fetchNonGdudUnitIds(date: string, unitIds: number[], transaction?: Transaction) {
        if (unitIds.length === 0) return [];

        const units = await this.unitModel.findAll({
            attributes: ["unitId"],
            where: {
                unitId: { [Op.in]: unitIds },
                unitLevelId: { [Op.ne]: UNIT_LEVELS.GDUD },
                objectType: OBJECT_TYPES.UNIT,
                startDate: { [Op.lte]: date },
                endDate: { [Op.gt]: date },
                ...getReportableUnitTypeWhere(),
            },
            transaction,
        });

        return Array.from(new Set(units.map(unit => unit.unitId)));
    }

    async inactivateUsageInventoryReportItemsForUnitsDate(unitIds: number[], date: string, transaction: Transaction) {
        if (unitIds.length === 0) return Promise.resolve(0);

        const reports = await this.reportModel.findAll({
            attributes: ["id"],
            where: {
                unitId: { [Op.in]: unitIds },
                unitObjectType: OBJECT_TYPES.UNIT,
                recipientUnitObjectType: OBJECT_TYPES.UNIT,
                reporterUnitObjectType: OBJECT_TYPES.UNIT,
                reportTypeId: { [Op.in]: [REPORT_TYPES.USAGE, REPORT_TYPES.INVENTORY] },
                createdOn: date,
            },
            transaction,
        });

        const reportIds = Array.from(new Set(reports.map(report => report.id)));
        if (reportIds.length === 0) return 0;

        const [updatedCount] = await this.reportItemModel.update(
            { status: RECORD_STATUS.INACTIVE },
            {
                where: {
                    reportId: { [Op.in]: reportIds },
                },
                transaction,
            }
        );

        return updatedCount;
    }

    clearStatusesForUnitsDate(unitIds: number[], date: string, transaction: Transaction) {
        if (unitIds.length === 0) return Promise.resolve(0);

        return this.unitStatusModel.destroy({
            where: {
                unitId: { [Op.in]: unitIds },
                date,
            },
            transaction,
        });
    }

    clearStatusForUnitDate(unitId: number, date: string, transaction?: Transaction) {
        return this.unitStatusModel.destroy({
            where: {
                unitId,
                date,
            },
            transaction,
        });
    }
}
