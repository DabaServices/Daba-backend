import { BadGatewayException, Injectable, Logger } from "@nestjs/common";
import { InjectModel } from "@nestjs/sequelize";
import { isEmpty, isNullish } from "remeda";
import { Op, QueryTypes } from "sequelize";
import { Sequelize } from "sequelize-typescript";
import { MATERIAL_TYPES, OBJECT_TYPES, RECORD_STATUS, REPORT_TYPES, UNIT_RELATION_TYPES, UNIT_STATUSES } from "../../../constants";
import { MainCategory } from "../../material-entities/categories/categories.model";
import { MaterialCategory } from "../../material-entities/material-category/material-category.model";
import { MaterialNickname } from "../../material-entities/material-nickname/material-nickname.model";
import { Material } from "../../material-entities/material/material.model";
import { getMaterialSupplyCenterTypeWhere } from "../../material-entities/material/material-query.utils";
import { UnitFavoriteMaterial } from "../../material-entities/unit-favorite-material/unit-favorite-material.model";
import { MaterialStandardGroup } from "../../standard-entities/material-standard-group/material-standard-group.model";
import { StandardGroup } from "../../standard-entities/standard-group/standard-group.model";
import { UnitId } from "../../unit-entities/unit-id/unit-id.model";
import { UnitRelation } from "../../unit-entities/unit-relations/unit-relation.model";
import { UnitStatus } from "../../unit-entities/units-statuses/units-statuses.model";
import { formatDate } from "../../../utils/date";
import { Comment } from "../comment/comment.model";
import { IReportItem, ReportItem } from "../report-item/report-item.model";
import { IReport, Report } from "./report.model";
import { MaterialDto, ReportChanges, ReportItemConflictField } from "./report.types";

export type StandardGroupMaterialRow = {
    groupId: string;
    groupDescription: string;
    materialId: string;
    materialDescription: string;
    unitOfMeasurement: string;
};

const getMaterialStandardGroupInclude = () => ({
    model: MaterialStandardGroup,
    as: "standardGroupMaterials",
    attributes: ["groupId", "materialId"],
    required: false,
    separate: true,
    include: [{
        model: StandardGroup,
        attributes: ["id", "name", "groupType"],
        required: false,
        include: [{
            association: "categoryGroup",
            attributes: ["id", "groupId"],
            required: false,
            include: [{
                association: "categoryDesc",
                attributes: ["id", "description"],
                required: false,
            }],
        }],
    }],
});

const getMaterialCategory = (material: Material) => {
    if (material.type === MATERIAL_TYPES.TOOL) {
        return material.standardGroupMaterials
            ?.find((standardGroupMaterial) => standardGroupMaterial.standardGroup?.categoryGroup?.categoryDesc?.description)
            ?.standardGroup?.categoryGroup?.categoryDesc?.description
            ?? material.materialCategory?.mainCategory?.description
            ?? "";
    }

    return material.materialCategory?.mainCategory?.description ?? "";
};

@Injectable()
export class ReportRepository {
    private readonly logger = new Logger(ReportRepository.name);

    constructor(@InjectModel(Report) private readonly reportModel: typeof Report,
        @InjectModel(ReportItem) private readonly reportItemModel: typeof ReportItem,
        @InjectModel(UnitFavoriteMaterial) private readonly unitFavoriteMaterialModel: typeof UnitFavoriteMaterial,
        @InjectModel(UnitRelation) private readonly unitRelationModel: typeof UnitRelation,
        @InjectModel(Material) private readonly materialModel: typeof Material,
        @InjectModel(MaterialStandardGroup) private readonly materialStandardGroupModel: typeof MaterialStandardGroup,
        @InjectModel(StandardGroup) private readonly standardGroupModel: typeof StandardGroup,
        @InjectModel(Comment) private readonly commentModel: typeof Comment) { }

    async saveReports<Key extends ReportItemConflictField>({
        reportsToSave,
        transaction,
        skipEmptyItems = true,
        fieldsToUpdate = ["confirmedQuantity"] as Key[]
    }: ReportChanges<Key>): Promise<void> {
        try {
            const updateOnDuplicate = Array.from(new Set<ReportItemConflictField>([
                "modifiedAt",
                "changedAt",
                "changedBy",
                "status",
                ...fieldsToUpdate,
            ]));

            for (const reportToSave of reportsToSave) {
                if (isEmpty(reportToSave.items) && skipEmptyItems) continue;

                const modifiedReport = await this.reportModel.upsert(reportToSave.header, {
                    conflictFields: ['created_on', 'recipient_unit_id', 'unit_id', 'report_type_id'] as unknown as (keyof IReport)[],
                    transaction
                })

                const itemsToModify = reportToSave.items.map(item => ({
                    ...item,
                    reportId: modifiedReport[0].dataValues.id
                }) as IReportItem)

                if (!isEmpty(reportToSave.items)) {
                    await this.reportItemModel.bulkCreate(itemsToModify, {
                        conflictAttributes: ["reportId", "materialId", "reportingLevel"],
                        updateOnDuplicate,
                        transaction
                    })
                }
            }
        } catch (error) {
            this.logger.error("Failed to save reports", error instanceof Error ? error.stack : String(error));

            throw new BadGatewayException({
                message: 'נכשלה פעולת השמירה, יש לנסות שוב',
                type: 'Failure'
            })
        }
    }

    async fetchParentUnits(date: Date, childUnitIds: number[]): Promise<Map<number, number>> {
        if (childUnitIds.length === 0) return new Map<number, number>();

        const relations = await this.unitRelationModel.findAll({
            attributes: ["unitId", "relatedUnitId"],
            where: {
                unitRelationId: UNIT_RELATION_TYPES.ZRA,
                unitObjectType: OBJECT_TYPES.UNIT,
                relatedUnitObjectType: OBJECT_TYPES.UNIT,
                relatedUnitId: { [Op.in]: childUnitIds },
                startDate: { [Op.lte]: date },
                endDate: { [Op.gt]: date }
            }
        });

        const parentByChild = new Map<number, number>();
        for (const relation of relations) {
            if (!parentByChild.has(relation.relatedUnitId)) {
                parentByChild.set(relation.relatedUnitId, relation.unitId);
            }
        }

        return parentByChild;
    }

    async fetchDescendantUnits(
        date: Date,
        rootUnitId: number
    ): Promise<{ descendantIds: number[]; parentByChild: Map<number, number> }> {
        const visited = new Set<number>([rootUnitId]);
        const parentByChild = new Map<number, number>();
        const descendantIds: number[] = [];

        let units = [rootUnitId];
        while (units.length > 0) {
            const relations = await this.unitRelationModel.findAll({
                attributes: ["unitId", "relatedUnitId"],
                include: [{
                    model: UnitId,
                    as: "relatedUnit",
                    required: true,
                    include: [{
                        model: UnitStatus,
                        required: true,
                        where: {
                            unitStatusId: { [Op.ne]: UNIT_STATUSES.REQUESTING },
                        },
                    }]
                }],
                where: {
                    unitRelationId: UNIT_RELATION_TYPES.ZRA,
                    unitObjectType: OBJECT_TYPES.UNIT,
                    relatedUnitObjectType: OBJECT_TYPES.UNIT,
                    unitId: { [Op.in]: units },
                    startDate: { [Op.lte]: date },
                    endDate: { [Op.gt]: date }
                },
            });
            const next: number[] = [];

            for (const relation of relations) {
                const childId = relation.relatedUnitId;

                if (!visited.has(childId)) {
                    visited.add(childId);
                    parentByChild.set(childId, relation.unitId);
                    descendantIds.push(childId);
                    next.push(childId);
                }
            }

            units = next;
        }

        return { descendantIds, parentByChild };
    }

    async fetchReportsByTypeAndUnitsForMaterials(
        date: string,
        reportType: number,
        materials: string[] | undefined = [],
        units: number[]
    ) {
        return this.reportModel.findAll({
            include: [{
                association: 'items',
                where: {
                    materialId: { [Op.in]: materials }
                }
            }],
            where: {
                reportTypeId: reportType,
                createdOn: new Date(date),
                unitId: { [Op.in]: units },
                unitObjectType: OBJECT_TYPES.UNIT,
                recipientUnitObjectType: OBJECT_TYPES.UNIT,
                reporterUnitObjectType: OBJECT_TYPES.UNIT,
            }
        })
    }

    async fetchActiveReportItemQuantitiesByUnitAndMaterial(
        date: string,
        reportType: number,
        materialIds: string[],
        unitIds: number[]
    ): Promise<Array<{ unitId: number; materialId: string; quantity: number }>> {
        if (materialIds.length === 0 || unitIds.length === 0) return [];

        const reports = await this.reportModel.findAll({
            attributes: ["unitId"],
            where: {
                reportTypeId: reportType,
                createdOn: new Date(date),
                unitId: { [Op.in]: unitIds },
                unitObjectType: OBJECT_TYPES.UNIT,
                recipientUnitObjectType: OBJECT_TYPES.UNIT,
                reporterUnitObjectType: OBJECT_TYPES.UNIT,
            },
            include: [{
                association: "items",
                required: true,
                attributes: ["materialId", "confirmedQuantity", "reportedQuantity"],
                where: {
                    materialId: { [Op.in]: materialIds },
                    status: RECORD_STATUS.ACTIVE,
                    reportingUnitObjectType: OBJECT_TYPES.UNIT,
                },
            }],
        });

        const quantityByUnitMaterial = new Map<string, number>();
        for (const report of reports) {
            for (const item of report.items ?? []) {
                const quantity = Number(item.confirmedQuantity ?? item.reportedQuantity ?? 0);
                const safeQuantity = Number.isNaN(quantity) ? 0 : quantity;
                const key = `${report.unitId}:${item.materialId}`;
                quantityByUnitMaterial.set(
                    key,
                    (quantityByUnitMaterial.get(key) ?? 0) + safeQuantity
                );
            }
        }

        return Array.from(quantityByUnitMaterial.entries()).map(([key, quantity]) => {
            const [unitIdAsString, materialId] = key.split(":");

            return {
                unitId: Number(unitIdAsString),
                materialId,
                quantity,
            };
        });
    }

    async fetchActiveReportItemQuantitiesByUnitMaterialAndType(
        date: string,
        reportTypeIds: number[],
        materialIds: string[],
        unitIds: number[]
    ): Promise<Array<{ unitId: number; materialId: string; reportTypeId: number; quantity: number }>> {
        if (reportTypeIds.length === 0 || materialIds.length === 0 || unitIds.length === 0) return [];

        const reports = await this.reportModel.findAll({
            attributes: ["unitId", "reportTypeId"],
            where: {
                reportTypeId: { [Op.in]: reportTypeIds },
                createdOn: new Date(date),
                unitId: { [Op.in]: unitIds },
                unitObjectType: OBJECT_TYPES.UNIT,
                recipientUnitObjectType: OBJECT_TYPES.UNIT,
                reporterUnitObjectType: OBJECT_TYPES.UNIT,
            },
            include: [{
                association: "items",
                required: true,
                attributes: ["materialId", "confirmedQuantity", "reportedQuantity"],
                where: {
                    materialId: { [Op.in]: materialIds },
                    status: RECORD_STATUS.ACTIVE,
                    reportingUnitObjectType: OBJECT_TYPES.UNIT,
                },
            }],
        });

        const quantityByKey = new Map<string, number>();
        for (const report of reports) {
            for (const item of report.items ?? []) {
                const quantity = Number(item.confirmedQuantity ?? item.reportedQuantity ?? 0);
                const safeQuantity = Number.isNaN(quantity) ? 0 : quantity;
                const key = `${report.reportTypeId}:${report.unitId}:${item.materialId}`;

                quantityByKey.set(
                    key,
                    (quantityByKey.get(key) ?? 0) + safeQuantity
                );
            }
        }

        return Array.from(quantityByKey.entries()).map(([key, quantity]) => {
            const [reportTypeIdAsString, unitIdAsString, materialId] = key.split(":");

            return {
                reportTypeId: Number(reportTypeIdAsString),
                unitId: Number(unitIdAsString),
                materialId,
                quantity,
            };
        });
    }

    private async fetchLatestReportIdsByUnitBeforeDate(
        date: string,
        reportTypeId: number,
        unitIds: number[]
    ): Promise<number[]> {
        if (unitIds.length === 0) return [];

        const rows = await this.reportModel.sequelize!.query<{ id: number }>(
            `SELECT id
               FROM (
                    SELECT id,
                           ROW_NUMBER() OVER (
                               PARTITION BY unit_id
                               ORDER BY created_on DESC, created_at DESC, id DESC
                           ) AS row_number
                      FROM reports
                     WHERE report_type_id = :reportTypeId
                       AND created_on < :date
                       AND unit_id IN (:unitIds)
                       AND unit_object_type = :unitObjectType
                       AND recipient_unit_object_type = :unitObjectType
                       AND reporter_unit_object_type = :unitObjectType
               ) latest_reports
              WHERE row_number = 1`,
            {
                replacements: {
                    date,
                    reportTypeId,
                    unitIds,
                    unitObjectType: OBJECT_TYPES.UNIT,
                },
                type: QueryTypes.SELECT,
            }
        );

        return rows.map(row => row.id);
    }

    async fetchLatestReportsByTypeAndUnitsForMaterials(
        date: string,
        reportTypeId: number,
        materialIds: string[],
        unitIds: number[]
    ): Promise<Report[]> {
        if (materialIds.length === 0 || unitIds.length === 0) return [];

        const reportIds = await this.fetchLatestReportIdsByUnitBeforeDate(date, reportTypeId, unitIds);
        if (reportIds.length === 0) return [];

        return this.reportModel.findAll({
            where: {
                id: { [Op.in]: reportIds },
            },
            include: this.buildReportsInclude(
                date,
                '',
                [RECORD_STATUS.ACTIVE, RECORD_STATUS.INACTIVE],
                materialIds
            ),
        });
    }

    async fetchLatestActiveReportItemQuantitiesByUnitAndMaterial(
        date: string,
        reportTypeId: number,
        materialIds: string[],
        unitIds: number[]
    ): Promise<Array<{ unitId: number; materialId: string; quantity: number }>> {
        if (materialIds.length === 0 || unitIds.length === 0) return [];

        const reportIds = await this.fetchLatestReportIdsByUnitBeforeDate(date, reportTypeId, unitIds);
        if (reportIds.length === 0) return [];

        const reports = await this.reportModel.findAll({
            attributes: ["unitId"],
            where: {
                id: { [Op.in]: reportIds },
            },
            include: [{
                association: "items",
                required: true,
                attributes: ["materialId", "confirmedQuantity", "reportedQuantity"],
                where: {
                    materialId: { [Op.in]: materialIds },
                    status: RECORD_STATUS.ACTIVE,
                    reportingUnitObjectType: OBJECT_TYPES.UNIT,
                },
            }],
        });

        const quantityByUnitMaterial = new Map<string, number>();
        for (const report of reports) {
            for (const item of report.items ?? []) {
                const quantity = Number(item.confirmedQuantity ?? item.reportedQuantity ?? 0);
                const safeQuantity = Number.isNaN(quantity) ? 0 : quantity;
                const key = `${report.unitId}:${item.materialId}`;
                quantityByUnitMaterial.set(
                    key,
                    (quantityByUnitMaterial.get(key) ?? 0) + safeQuantity
                );
            }
        }

        return Array.from(quantityByUnitMaterial.entries()).map(([key, quantity]) => {
            const [unitIdAsString, materialId] = key.split(":");

            return {
                unitId: Number(unitIdAsString),
                materialId,
                quantity,
            };
        });
    }

    async fetchReportsData(
        date: string,
        recipientUnitId: number,
        material: string | undefined = ''
    ): Promise<Report[]> {
        const { unitIds } = await this.buildReportScope(date, recipientUnitId);

        return this.fetchReportsByScope({
            date,
            reportingUnitIds: unitIds,
            material,
            itemStatuses: [RECORD_STATUS.ACTIVE, RECORD_STATUS.INACTIVE]
        });
    }

    async fetchAllocationReportsData(
        date: string,
        recipientUnitId: number
    ): Promise<Report[]> {
        const { unitIds } = await this.buildReportScope(date, recipientUnitId);
        return this.fetchReportsByScope({
            date,
            reportingUnitIds: unitIds,
            recipientUnitIds: unitIds,
            reportTypeIds: [REPORT_TYPES.ALLOCATION],
            itemStatuses: [RECORD_STATUS.ACTIVE, RECORD_STATUS.INACTIVE]
        });
    }

    async fetchReportsForRecipientsByType(
        date: string,
        reportTypeId: number,
        recipientUnitIds: number[],
        reportingUnitIds: number[] = [],
        materialIds: string[] = []
    ): Promise<Report[]> {
        if (recipientUnitIds.length === 0) return [];

        return this.fetchReportsByScope({
            date,
            reportingUnitIds,
            recipientUnitIds,
            reportTypeIds: [reportTypeId],
            itemStatuses: [RECORD_STATUS.ACTIVE, RECORD_STATUS.INACTIVE],
            materialIds
        });
    }

    async fetchIncomingAllocationReports(
        date: string,
        recipientUnitId: number,
        materialIds: string[] = []
    ): Promise<Report[]> {
        return this.reportModel.findAll({
            where: {
                unitObjectType: OBJECT_TYPES.UNIT,
                recipientUnitId,
                recipientUnitObjectType: OBJECT_TYPES.UNIT,
                reporterUnitObjectType: OBJECT_TYPES.UNIT,
                createdOn: date,
                reportTypeId: REPORT_TYPES.ALLOCATION,
            },
            include: this.buildReportsInclude(
                date,
                undefined,
                [RECORD_STATUS.ACTIVE, RECORD_STATUS.INACTIVE],
                materialIds
            ),
        });
    }

    async fetchStandaloneCommentsData(
        date: string,
        recipientUnitId: number
    ): Promise<Comment[]> {
        const { unitIds } = await this.buildReportScope(date, recipientUnitId);
        const comments = await this.commentModel.findAll({
            where: {
                date: new Date(date),
                [Op.and]: [
                    { text: { [Op.ne]: null } },
                    { text: { [Op.ne]: "" } },
                    {
                        [Op.or]: [
                            {
                                type: { [Op.ne]: REPORT_TYPES.ALLOCATION },
                                unitId: { [Op.in]: unitIds },
                                recipientUnitId,
                            },
                            {
                                type: { [Op.ne]: REPORT_TYPES.ALLOCATION },
                                unitId: recipientUnitId,
                            },
                            {
                                type: REPORT_TYPES.ALLOCATION,
                                recipientUnitId,
                            },
                            {
                                type: REPORT_TYPES.ALLOCATION,
                                unitId: recipientUnitId,
                                recipientUnitId: { [Op.in]: unitIds },
                            },
                        ],
                    },
                ],
            },
            include: [{
                association: "unit",
                required: false,
                include: [{
                    association: "details",
                    required: false,
                    attributes: ["unitId", "description", "unitLevelId", "startDate", "tsavIrgunCodeId"],
                    where: {
                        startDate: { [Op.lte]: date },
                        endDate: { [Op.gt]: date },
                        objectType: OBJECT_TYPES.UNIT,
                    }
                }, {
                    association: "unitStatus",
                    required: false,
                    attributes: ["unitStatusId", "date"],
                    where: {
                        date,
                    },
                    include: [{
                        association: "unitStatus",
                        attributes: ["id", "description"],
                    }],
                }]
            }, {
                association: "recipientUnit",
                required: false,
                include: [{
                    association: "details",
                    required: false,
                    attributes: ["unitId", "description", "unitLevelId", "startDate", "tsavIrgunCodeId"],
                    where: {
                        startDate: { [Op.lte]: date },
                        endDate: { [Op.gt]: date },
                        objectType: OBJECT_TYPES.UNIT,
                    }
                }, {
                    association: "unitStatus",
                    required: false,
                    attributes: ["unitStatusId", "date"],
                    where: {
                        date,
                    },
                    include: [{
                        association: "unitStatus",
                        attributes: ["id", "description"],
                    }],
                }]
            }, {
                association: "material",
                required: false,
                include: [{
                    model: MaterialNickname,
                    as: "nickname",
                    required: false,
                }, {
                    model: MaterialCategory,
                    as: "materialCategory",
                    required: false,
                    include: [{
                        model: MainCategory,
                        as: "mainCategory",
                        required: false,
                    }],
                },
                getMaterialStandardGroupInclude()],
            }],
        });

        const standardGroupIds = Array.from(new Set(
            comments
                .filter(comment => !comment.material)
                .map(comment => comment.materialId)
        ));

        if (standardGroupIds.length === 0) {
            return comments;
        }

        const standardGroups = await this.standardGroupModel.findAll({
            include: [{
                association: "nickname",
                required: false,
            }, {
                association: "categoryGroup",
                required: false,
                include: [{
                    association: "categoryDesc",
                    attributes: ["id", "description"],
                    required: false,
                }]
            }],
            where: {
                id: { [Op.in]: standardGroupIds }
            }
        });
        const standardGroupById = new Map(standardGroups.map(standardGroup => [standardGroup.id, standardGroup]));

        comments.forEach(comment => {
            if (!comment.material) {
                (comment as Comment & { standardGroup?: StandardGroup }).standardGroup = standardGroupById.get(comment.materialId);
            }
        });

        return comments;
    }

    async fetchOutgoingAllocationReports(
        date: string,
        unitId: number,
        recipientUnitIds: number[],
        materialIds: string[] = []
    ): Promise<Report[]> {
        if (recipientUnitIds.length === 0) return [];

        return this.fetchReportsByScope({
            date,
            reportingUnitIds: [unitId],
            recipientUnitIds,
            reportTypeIds: [REPORT_TYPES.ALLOCATION],
            itemStatuses: [RECORD_STATUS.ACTIVE],
            materialIds,
        });
    }

    async fetchStandardGroupMaterials(groupIds: string[]): Promise<StandardGroupMaterialRow[]> {
        if (groupIds.length === 0) return [];

        const mappings = await this.materialStandardGroupModel.findAll({
            where: {
                groupId: { [Op.in]: groupIds },
            },
            include: [{
                model: Material,
                required: true,
                attributes: ["id", "description", "unitOfMeasurement"],
            }, {
                model: StandardGroup,
                required: true,
                attributes: ["id", "name"],
            }],
            order: [["groupId", "ASC"], ["materialId", "ASC"]],
        });

        return mappings.map((mapping) => ({
            groupId: mapping.groupId,
            groupDescription: mapping.standardGroup?.name ?? "",
            materialId: mapping.materialId,
            materialDescription: mapping.material?.description ?? "",
            unitOfMeasurement: mapping.material?.unitOfMeasurement ?? "",
        }));
    }

    async fetchFavoriteReportsData(
        date: string,
        recipientUnitId: number
    ): Promise<Report[]> {
        const favorites = await this.unitFavoriteMaterialModel.findAll({
            attributes: ["materialId"],
            where: { unitId: recipientUnitId }
        });
        const favoriteMaterialIds = Array.from(new Set(favorites.map((favorite) => favorite.materialId)));
        if (favoriteMaterialIds.length === 0) return [];

        const { descendantIds, unitIds } = await this.buildReportScope(date, recipientUnitId);
        return this.fetchReportsByScope({
            date,
            reportingUnitIds: descendantIds,
            recipientUnitIds: unitIds,
            itemStatuses: [RECORD_STATUS.ACTIVE, RECORD_STATUS.INACTIVE],
            materialIds: favoriteMaterialIds
        });
    }

    async fetchFavoriteMaterials(recipientUnitId: number): Promise<MaterialDto[]> {
        const favorites = await this.unitFavoriteMaterialModel.findAll({
            attributes: ["materialId"],
            where: { unitId: recipientUnitId }
        });
        const favoriteIds = Array.from(new Set(favorites.map((favorite) => favorite.materialId)));
        if (favoriteIds.length === 0) return [];

        const [materials, standardGroups] = await Promise.all([
            this.materialModel.findAll({
                where: {
                    id: { [Op.in]: favoriteIds },
                    recordStatus: RECORD_STATUS.ACTIVE,
                    ...getMaterialSupplyCenterTypeWhere()
                },
                include: [{
                    association: "nickname",
                    required: false,
                }, {
                    association: "materialCategory",
                    required: false,
                    include: [{
                        association: "mainCategory",
                        required: false,
                    }],
                },
                getMaterialStandardGroupInclude()],
            }),
            this.standardGroupModel.findAll({
                include: [{
                    association: "nickname",
                    required: false,
                }, {
                    association: "categoryGroup",
                    required: false,
                    include: [{
                        association: "categoryDesc",
                        attributes: ["id", "description"],
                        required: false,
                    }],
                }],
                where: {
                    id: { [Op.in]: favoriteIds }
                }
            })
        ]);

        return [
            ...materials.map((material) => ({
                id: material.id,
                description: material.description ?? "",
                multiply: Number(material.multiply ?? 0),
                nickname: material.nickname?.nickname ?? "",
                category: getMaterialCategory(material),
                unitOfMeasure: material.unitOfMeasurement ?? "",
                type: material.type,
                isGroup: false
            })),
            ...standardGroups.map((standardGroup) => ({
                id: standardGroup.id,
                description: standardGroup.name ?? "",
                multiply: 0,
                nickname: standardGroup.nickname?.nickname ?? "",
                category: standardGroup.categoryGroup?.categoryDesc?.description ?? "קבוצה",
                unitOfMeasure: "",
                type: standardGroup.groupType,
                isGroup: true
            }))
        ].sort((left, right) => left.id.localeCompare(right.id));
    }

    async fetchMostRecentReportsData(
        date: string,
        recipientUnitId: number
    ): Promise<Report[]> {
        const { descendantIds, unitIds } = await this.buildReportScope(date, recipientUnitId);
        if (descendantIds.length === 0) return [];

        const latestCreatedOn: Date = await this.reportModel.max("createdOn", {
            where: {
                unitId: { [Op.in]: descendantIds },
                unitObjectType: OBJECT_TYPES.UNIT,
                recipientUnitId: { [Op.in]: unitIds },
                recipientUnitObjectType: OBJECT_TYPES.UNIT,
                reporterUnitObjectType: OBJECT_TYPES.UNIT,
                createdOn: { [Op.lt]: date },
                reportTypeId: { [Op.in]: [REPORT_TYPES.REQUEST, REPORT_TYPES.INVENTORY, REPORT_TYPES.USAGE] }
            }
        });

        if (isNullish(latestCreatedOn)) return [];

        const { formattedDate: latestDate } = formatDate(latestCreatedOn);

        return this.fetchReportsByScope({
            date: latestDate,
            reportingUnitIds: descendantIds,
            recipientUnitIds: unitIds,
            itemStatuses: [RECORD_STATUS.ACTIVE, RECORD_STATUS.INACTIVE]
        });
    }

    async fetchHierarchyReportsByType(
        date: string,
        recipientUnitId: number,
        reportTypeId: number,
        materialIds: string[] = []
    ): Promise<Report[]> {
        if (materialIds.length === 0) return [];

        const { unitIds } = await this.buildReportScope(date, recipientUnitId);
        return this.fetchReportsByScope({
            date,
            reportingUnitIds: unitIds,
            reportTypeIds: [reportTypeId],
            itemStatuses: [RECORD_STATUS.ACTIVE, RECORD_STATUS.INACTIVE],
            materialIds,
        });
    }

    async fetchLatestHierarchyReportsByType(
        date: string,
        recipientUnitId: number,
        reportTypeId: number,
        materialIds: string[] = []
    ): Promise<Report[]> {
        if (materialIds.length === 0) return [];

        const { unitIds } = await this.buildReportScope(date, recipientUnitId);
        return this.fetchLatestReportsByTypeAndUnitsForMaterials(
            date,
            reportTypeId,
            materialIds,
            unitIds
        );
    }

    async fetchReportsDataForUnits(
        date: string,
        unitIds: number[],
    ): Promise<Report[]> {
        if (unitIds.length === 0) return [];

        return this.reportModel.findAll({
            where: {
                unitId: { [Op.in]: unitIds },
                unitObjectType: OBJECT_TYPES.UNIT,
                recipientUnitId: { [Op.in]: unitIds },
                recipientUnitObjectType: OBJECT_TYPES.UNIT,
                reporterUnitObjectType: OBJECT_TYPES.UNIT,
                createdOn: date,
                reportTypeId: { [Op.in]: [REPORT_TYPES.REQUEST, REPORT_TYPES.INVENTORY, REPORT_TYPES.USAGE] },
            },
            include: this.buildReportsInclude(date),
        });
    }

    private async buildReportScope(date: string, recipientUnitId: number) {
        const { descendantIds } = await this.fetchDescendantUnits(new Date(date), recipientUnitId);
        return {
            descendantIds,
            unitIds: [recipientUnitId, ...descendantIds]
        };
    }

    fetchReportsByScope({
        date,
        reportingUnitIds = [],
        recipientUnitIds,
        reportTypeIds = [REPORT_TYPES.REQUEST, REPORT_TYPES.INVENTORY, REPORT_TYPES.USAGE],
        material = '',
        itemStatuses = [RECORD_STATUS.ACTIVE],
        materialIds
    }: {
        date: string;
        reportingUnitIds?: number[];
        recipientUnitIds?: number[];
        reportTypeIds?: number[];
        material?: string;
        itemStatuses?: string[];
        materialIds?: string[];
    }): Promise<Report[]> {
        if (reportingUnitIds.length === 0 && !recipientUnitIds?.length) return Promise.resolve([]);

        const whereClause: {
            createdOn: string;
            reportTypeId: { [Op.in]: number[] };
            unitId?: { [Op.in]: number[] };
            unitObjectType: string;
            recipientUnitId?: { [Op.in]: number[] };
            recipientUnitObjectType: string;
            reporterUnitObjectType: string;
        } = {
            createdOn: date,
            reportTypeId: { [Op.in]: reportTypeIds },
            unitObjectType: OBJECT_TYPES.UNIT,
            recipientUnitObjectType: OBJECT_TYPES.UNIT,
            reporterUnitObjectType: OBJECT_TYPES.UNIT,
        };

        if (reportingUnitIds.length > 0) {
            whereClause.unitId = { [Op.in]: reportingUnitIds };
        }

        if (recipientUnitIds?.length) {
            whereClause.recipientUnitId = { [Op.in]: recipientUnitIds };
        }

        return this.reportModel.findAll({
            where: whereClause,
            include: this.buildReportsInclude(
                date,
                material,
                itemStatuses,
                materialIds
            ),
        });
    }

    private buildReportsInclude(
        date: string,
        material: string | undefined = '',
        itemStatuses: string[] = [RECORD_STATUS.ACTIVE],
        materialIds: string[] = []
    ) {
        const materialFilter = materialIds.length > 0
            ? { [Op.in]: materialIds }
            : { [Op.iLike]: `%${material}%` };

        return [{
            association: "unit",
            required: false,
            include: [{
                association: "details",
                required: false,
                attributes: ["unitId", "description", "unitLevelId", "startDate", "tsavIrgunCodeId"],
                where: {
                    startDate: { [Op.lte]: date },
                    endDate: { [Op.gt]: date },
                    objectType: OBJECT_TYPES.UNIT,
                }
            }, {
                association: "unitStatus",
                required: false,
                attributes: ["unitStatusId", "date"],
                where: {
                    date,
                },
                include: [{
                    association: "unitStatus",
                    attributes: ["id", "description"],
                }],
            }]
        }, {
            association: "recipientUnit",
            required: false,
            include: [{
                association: "details",
                required: false,
                attributes: ["unitId", "description", "unitLevelId", "startDate", "tsavIrgunCodeId"],
                where: {
                    startDate: { [Op.lte]: date },
                    endDate: { [Op.gt]: date },
                    objectType: OBJECT_TYPES.UNIT,
                }
            }, {
                association: "unitStatus",
                required: false,
                attributes: ["unitStatusId", "date"],
                where: {
                    date,
                },
                include: [{
                    association: "unitStatus",
                    attributes: ["id", "description"],
                }],
            }]
        }, {
            attributes: ['reportedQuantity', 'confirmedQuantity', 'balanceQuantity', 'status', 'materialId', 'reportingLevel', 'reportingUnitId', 'reportingUnitObjectType'],
            model: ReportItem,
            as: "items",
            include: [{
                model: Material,
                as: "material",
                required: false,
                include: [{
                    model: MaterialNickname,
                    as: "nickname",
                    required: false,
                }, {
                    model: MaterialCategory,
                    as: "materialCategory",
                    required: false,
                    include: [{
                        model: MainCategory,
                        as: "mainCategory",
                        required: false,
                    }],
                },
                getMaterialStandardGroupInclude()],
            }, {
                model: StandardGroup,
                as: "standardGroup",
                required: false,
                include: [{
                    association: "nickname",
                    required: false,
                }, {
                    association: "categoryGroup",
                    required: false,
                    include: [{
                        association: "categoryDesc",
                        attributes: ["id", "description"],
                        required: false,
                    }],
                }]
            }],
            where: {
                materialId: materialFilter,
                modifiedAt: {
                    [Op.eq]: Sequelize.literal(`(SELECT MAX(shoval.report_items."modified_at")
                                              FROM shoval.report_items
                                             WHERE shoval.report_items."report_id" = "Report"."id"
                                               AND shoval.report_items."material_id" = "items"."material_id"
                                               AND shoval.report_items."status" IN (${itemStatuses.map((status) => `'${status}'`).join(", ")}))`)
                },
                status: { [Op.in]: itemStatuses },
                reportingUnitObjectType: OBJECT_TYPES.UNIT,
            },

        }];
    }
}
