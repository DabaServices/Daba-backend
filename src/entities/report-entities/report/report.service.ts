import { BadGatewayException, BadRequestException, Injectable, Logger } from "@nestjs/common";
import { isEmptyish } from "remeda";
import { Error } from "sequelize";
import { Sequelize } from "sequelize-typescript";
import { MATKAL_UNIT_ID, MESSAGE_TYPES, RECORD_STATUS, REPORT_TYPES, UNIT_LEVELS, UNIT_STATUSES } from "../../../constants";
import { formatDate } from "../../../utils/date";
import { UnitHierarchyService } from "../../unit-entities/features/unit-hierarchy/unit-hierarchy.service";
import { UnitRelation } from "../../unit-entities/unit-relations/unit-relation.model";
import { UnitRepository } from "../../unit-entities/unit/unit.repository";
import { UnitStatusService } from "../../unit-entities/units-statuses/units-statuses.service";
import type { Report } from "./report.model";
import { ReportRepository, type StandardGroupMaterialRow } from "./report.repository";
import {
    AllocationDuhExportDto,
    AggregateReportsDTO,
    FavoriteReportDto,
    InventoryCalculationResultDto,
    IReportsChanges,
    ReportDto,
    SaveAllocationsDTO,
    SaveCommitteesBody
} from "./report.types";
import {
    assertLowerHierarchyStable,
    buildChildrenByParentMap,
    buildHierarchyIndexes,
    buildUnitResolver,
    buildUnitsMap,
    collectHierarchyUnitIds,
    getAggregatedReports,
    sortNumeric,
} from "./utilities/report-aggregate-hierarchy.utils";
import {
    buildAllocationBalanceUpdates,
    buildAllocationsChanges,
    buildConfirmedAllocationChanges,
    buildDownloadAllocationChanges,
    buildNextLevelAllocationDraftChanges
} from "./utilities/report-allocation-save.utils";
import { aggregateAllocationDuhRows } from "./utilities/allocation-duh-export.utils";
import {
    buildFavoriteReportsResponse,
    buildReportsMaterialsResponse,
    buildReportsResponse
} from "./utilities/report-fetch.utils";
import { buildReportsToSave } from "./utilities/report-save.utils";
import {
    aggregateGdudQuantitiesToAncestors,
    buildChildIdsByParent,
    buildInventoryCalculationResults,
    buildParentByChildForConnectedUnits,
    buildUnitLevelById,
    buildUnitMaterialQuantityMap,
    collectMaterialIdsFromReports,
    collectUnitsForLockedDirectChildBranches,
} from "./utilities/report-service.utils";

type AllocationExportUnitRow = {
    description: string;
    simul: string;
    unitLevelId: number;
};

type AllocationExportMaterialRow = {
    materialId: string;
    materialDescription: string;
    unitOfMeasure: string;
    standardGroupId?: string;
};

@Injectable()
export class ReportService {
    private readonly logger = new Logger(ReportService.name);

    constructor(
        private readonly repository: ReportRepository,
        private readonly sequelize: Sequelize,
        private readonly unitHierarchyService: UnitHierarchyService,
        private readonly unitRepository: UnitRepository,
        private readonly unitStatusService: UnitStatusService,
    ) { }

    async saveReportsChanges(
        saveReportsBody: SaveCommitteesBody,
        date: string,
        screenUnitId: number,
        username: string,
    ) {
        const changes = saveReportsBody?.changes ?? [];
        const reportingUnitId = screenUnitId;
        const transaction = await this.sequelize.transaction();
        const { formattedTime } = formatDate(new Date());
        const screenDate = new Date(date);

        try {
            const unitDetails = await this.unitRepository.fetchActiveUnitDetails(screenDate, reportingUnitId);

            const activeRelations = await this.unitHierarchyService.fetchActiveRelations(date) as UnitRelation[];

            const lowerUnitsIds = sortNumeric(
                activeRelations.filter(reltion => reltion.dataValues.unitId === screenUnitId).map(unit => unit.dataValues.relatedUnitId)
            );

            assertLowerHierarchyStable(saveReportsBody.children, lowerUnitsIds);

            const parentByChild = await this.repository.fetchParentUnits(
                screenDate,
                Array.from(new Set(changes.map(change => change.unitId)))
            );

            const reportsToSave = buildReportsToSave({
                changes,
                reportingLevel: unitDetails?.unitLevelId!,
                reportingUnitId,
                recipientUnitId: screenUnitId,
                createdOn: screenDate,
                createdAt: formattedTime,
                createdBy: username,
                parentByChild
            });

            await this.repository.saveReports({
                reportsToSave,
                transaction,
                fieldsToUpdate: ["confirmedQuantity"],
            });

            await transaction.commit();
            return {
                type: MESSAGE_TYPES.SUCCESS,
                message: "הנתונים נשמרו בהצלחה"
            };
        } catch (error: any) {
            this.logger.error("Failed to save report changes", error instanceof Error ? error.stack : String(error));

            await transaction.rollback();
            throw new BadGatewayException({
                message: error?.response?.message ?? 'נכשלה פעולת השמירה, יש לנסות שוב',
                type: MESSAGE_TYPES.FAILURE
            })
        }
    }

    async fetchReports(
        date: string,
        requestedScreenUnitId: number,
        username = '',
    ): Promise<ReportDto[]> {
        const screenUnitId = requestedScreenUnitId > 0
            ? requestedScreenUnitId
            : await this.unitHierarchyService.getRootUnitIdForUser(username);
        const [baseReports, allocationReports, screenAllocationReports, standaloneComments] = await Promise.all([
            this.repository.fetchReportsData(date, screenUnitId),
            this.repository.fetchAllocationReportsData(date, screenUnitId),
            this.repository.fetchIncomingAllocationReports(date, screenUnitId),
            this.repository.fetchStandaloneCommentsData(date, screenUnitId),
        ]);

        const reports = [...baseReports, ...allocationReports, ...screenAllocationReports];
        const materialIds = collectMaterialIdsFromReports([
            ...reports,
            ...screenAllocationReports,
        ]);

        const latestInventoryReports = materialIds.length === 0
            ? []
            : await this.repository.fetchLatestHierarchyReportsByType(
                date,
                screenUnitId,
                REPORT_TYPES.INVENTORY,
                materialIds
            );

        return buildReportsResponse({
            screenUnitId,
            reports,
            standaloneComments,
            yesterdayInventoryReports: latestInventoryReports,
            screenAllocationReports,
        });
    }

    async fetchFavoriteReports(date: string, recipientUnitId: number): Promise<{ data: FavoriteReportDto[]; message: string; type: string }> {
        try {

            const directChildren = await this.unitHierarchyService.fetchLowerUnits(date, recipientUnitId)

            const reportTypeIds = [
                REPORT_TYPES.REQUEST,
                REPORT_TYPES.INVENTORY,
                REPORT_TYPES.USAGE,
                REPORT_TYPES.ALLOCATION,
            ];

            const favoriteMaterials = await this.repository.fetchFavoriteMaterials(recipientUnitId);
            const latestInventoryReports = favoriteMaterials.length === 0
                ? []
                : await this.repository.fetchLatestHierarchyReportsByType(
                    date,
                    recipientUnitId,
                    REPORT_TYPES.INVENTORY,
                    favoriteMaterials.map((material) => material.id)
                );

            const data = buildFavoriteReportsResponse(
                favoriteMaterials,
                directChildren,
                reportTypeIds,
                latestInventoryReports
            );

            if (isEmptyish(data)) {
                console.log("AS");

                throw new BadGatewayException({
                    message: 'לא נמצאו מק״טים מועדפים',
                    type: MESSAGE_TYPES.WARNING
                })
            }

            return {
                data: data,
                message: 'ייבוא המק״טים צלח',
                type: MESSAGE_TYPES.SUCCESS
            };
        } catch (error: any) {
            console.log(error);

            throw new BadGatewayException({
                message: error?.response?.message ?? 'הבאת מק״טים מועדפים נכשלה, יש לנסות שנית',
                type: error?.response?.type ?? MESSAGE_TYPES.FAILURE
            })
        }
    }

    async fetchMostRecentMaterials(date: string, screenUnitId: number) {
        try {
            const reports = await this.repository.fetchMostRecentReportsData(date, screenUnitId);

            if (isEmptyish(reports)) {
                throw new BadGatewayException({
                    message: 'לא נמצאה ועדה אחרונה',
                    type: MESSAGE_TYPES.WARNING
                })
            }

            const materialIds = collectMaterialIdsFromReports(reports);
            const latestInventoryReports = materialIds.length === 0
                ? []
                : await this.repository.fetchLatestHierarchyReportsByType(
                    date,
                    screenUnitId,
                    REPORT_TYPES.INVENTORY,
                    materialIds
                );

            return {
                data: buildReportsMaterialsResponse({
                    screenUnitId,
                    reports,
                    yesterdayInventoryReports: latestInventoryReports,
                    fetchQuantity: false
                }),
                message: 'ייבוא המק״טים צלח',
                type: MESSAGE_TYPES.SUCCESS
            };
        } catch (error: any) {
            console.log(error);

            throw new BadGatewayException({
                message: error?.response?.message ?? 'נכשלה הבאת המק״טים מועדה אחרונה',
                type: error?.response?.type ?? MESSAGE_TYPES.FAILURE
            });
        }
    }

    async aggregateHierarchy(
        date: string,
        screenUnitId: number,
        user: string,
        aggregatedReportsDTO: AggregateReportsDTO
    ) {
        const transaction = await this.sequelize.transaction();

        try {
            const activeRelations = await this.unitHierarchyService.fetchActiveRelations(date) as UnitRelation[];
            const emergencyUnitLookup = this.unitHierarchyService.buildEmergencyUnitLookup(activeRelations);
            const { childrenByParent, parentsByChild, unitsById } = buildHierarchyIndexes(
                activeRelations,
                emergencyUnitLookup
            );

            const connectedUnitIds = collectHierarchyUnitIds(screenUnitId, childrenByParent);
            const connectedUnitSet = new Set<number>(connectedUnitIds);

            const lowerUnitsIds = sortNumeric(
                (childrenByParent.get(screenUnitId) ?? []).filter((unitId) => connectedUnitSet.has(unitId))
            );

            assertLowerHierarchyStable(aggregatedReportsDTO.lowerUnitsIds ?? [], lowerUnitsIds);

            const resolveUnit = buildUnitResolver(unitsById, emergencyUnitLookup);

            const unitsMap = buildUnitsMap(connectedUnitIds, screenUnitId, parentsByChild, resolveUnit);
            const childrenByParentMap = buildChildrenByParentMap(
                childrenByParent,
                connectedUnitSet,
                unitsMap,
                resolveUnit
            );

            const dbReports = await this.repository.fetchReportsDataForUnits(
                date,
                connectedUnitIds,
            );
            
            const reportsToSave = await getAggregatedReports({
                date,
                unitsToLaunch: aggregatedReportsDTO.unitsIds,
                screenUnitId,
                unitsMap,
                childrenByParentMap,
                dbReports,
                username: user,
                isLaunching: aggregatedReportsDTO.isLaunching,
            });

            await this.repository.saveReports({
                reportsToSave: reportsToSave ?? [],
                transaction,
                fieldsToUpdate: ["confirmedQuantity", "reportedQuantity"],
            });

            await this.unitStatusService.updateHierarchyStatusesInTransaction({
                unitsIds: aggregatedReportsDTO.unitsIds,
                statusId: UNIT_STATUSES.WAITING_FOR_ALLOCATION,
                updateHierarchy: true
            }, date, transaction);

            await transaction.commit();

            return {
                type: isEmptyish(reportsToSave) ? MESSAGE_TYPES.WARNING : MESSAGE_TYPES.SUCCESS,
                message: isEmptyish(reportsToSave) ? 'אין דיווחים להעלות' : 'הדיווחים הועלו בהצלחה',
            };
        } catch (error: any) {
            await transaction.rollback();

            this.logger.error("Failed to aggregate hierarchy", error instanceof Error ? error.stack : String(error));
            throw new BadGatewayException({
                message: error?.response?.message ?? 'נעילת ההיררכיה נכשלה, יש לנסות שוב',
                type: MESSAGE_TYPES.FAILURE
            });
        }
    }

    async inventoryCalculation(
        date: string,
        screenUnitId: number,
        materialIds: string[] = []
    ): Promise<{ data: InventoryCalculationResultDto[]; message: string; type: string }> {
        try {
            if (materialIds.length === 0) {
                throw new BadRequestException({
                    message: 'אין מק״טים לחשב עבורם מלאי',
                    type: MESSAGE_TYPES.FAILURE
                });
            }

            const activeRelations = await this.unitHierarchyService.fetchActiveRelations(date) as UnitRelation[];
            const emergencyUnitLookup = this.unitHierarchyService.buildEmergencyUnitLookup(activeRelations);
            const { childrenByParent, parentsByChild, unitsById } = buildHierarchyIndexes(
                activeRelations,
                emergencyUnitLookup
            );

            const connectedUnitIds = collectUnitsForLockedDirectChildBranches(
                screenUnitId,
                childrenByParent,
                unitsById
            );
            const connectedUnitSet = new Set<number>(connectedUnitIds);
            const gdudUnitIds = connectedUnitIds.filter(
                (unitId) => (unitsById.get(unitId)?.level) === UNIT_LEVELS.GDUD
            );

            const parentByChild = buildParentByChildForConnectedUnits(
                connectedUnitIds,
                parentsByChild,
                connectedUnitSet
            );

            const [latestInventory, todayUsage] = await Promise.all([
                this.repository.fetchLatestActiveReportItemQuantitiesByUnitAndMaterial(
                    date,
                    REPORT_TYPES.INVENTORY,
                    materialIds,
                    gdudUnitIds
                ),
                this.repository.fetchActiveReportItemQuantitiesByUnitAndMaterial(
                    date,
                    REPORT_TYPES.USAGE,
                    materialIds,
                    gdudUnitIds
                ),
            ]);

            const inventoryByUnitMaterial = buildUnitMaterialQuantityMap(latestInventory);
            const usageByUnitMaterial = buildUnitMaterialQuantityMap(todayUsage);

            const aggregatedInventoryByUnitMaterial = aggregateGdudQuantitiesToAncestors(
                inventoryByUnitMaterial,
                parentByChild,
                connectedUnitSet,
                screenUnitId,
                true
            );
            const aggregatedUsageByUnitMaterial = aggregateGdudQuantitiesToAncestors(
                usageByUnitMaterial,
                parentByChild,
                connectedUnitSet,
                screenUnitId,
                true
            );
            const data = buildInventoryCalculationResults(
                aggregatedInventoryByUnitMaterial,
                aggregatedUsageByUnitMaterial
            );

            if (isEmptyish(data)) {
                throw new BadGatewayException({
                    message: 'לא נמצא מלאי לחישוב',
                    type: MESSAGE_TYPES.FAILURE
                })
            }

            return {
                data: data,
                message: 'חישוב המלאי הצליח',
                type: MESSAGE_TYPES.SUCCESS
            }
        } catch (error: any) {
            console.log(error.response.message);

            throw new BadGatewayException({
                message: error?.response?.message ?? 'חישוב המלאי נכשל, יש לנסות שנית',
                type: MESSAGE_TYPES.FAILURE
            })
        }
    }

    private buildAllocationDuhUnitMap(directChildRelations: UnitRelation[]): Map<number, AllocationExportUnitRow> {
        const unitById = new Map<number, AllocationExportUnitRow>();

        for (const relation of directChildRelations) {
            if (unitById.has(relation.relatedUnitId)) continue;

            const detail = relation.relatedUnit?.activeDetail;
            if (!detail) continue;

            unitById.set(relation.relatedUnitId, {
                description: detail.description ?? "",
                simul: detail.tsavIrgunCodeId ?? "",
                unitLevelId: detail.unitLevelId ?? UNIT_LEVELS.MATKAL,
            });
        }

        return unitById;
    }

    private buildAllocationDuhSourceMaterialMap(
        reports: Report[],
        useRecipientUnitId: boolean
    ): Map<string, AllocationExportMaterialRow> {
        const materialByUnitMaterial = new Map<string, AllocationExportMaterialRow>();

        for (const report of reports) {
            const targetUnitId = useRecipientUnitId
                ? report.recipientUnitId
                : report.unitId;

            if (targetUnitId === null) continue;

            for (const item of report.items ?? []) {
                const key = `${targetUnitId}:${item.materialId}`;
                if (materialByUnitMaterial.has(key)) continue;

                materialByUnitMaterial.set(key, {
                    materialId: item.materialId,
                    materialDescription: item.material?.description ?? item.standardGroup?.name ?? "",
                    unitOfMeasure: item.material?.unitOfMeasurement ?? "",
                    standardGroupId: item.standardGroup?.id,
                });
            }
        }

        return materialByUnitMaterial;
    }

    private async buildAllocationDuhExport({
        date,
        allocationChanges,
        directChildRelations,
        outgoingAllocationReports,
        requisitionReports,
    }: {
        date: string;
        allocationChanges: SaveAllocationsDTO["changes"];
        directChildRelations: UnitRelation[];
        outgoingAllocationReports: Report[];
        requisitionReports: Report[];
    }): Promise<AllocationDuhExportDto | null> {
        if (allocationChanges.length === 0) {
            return null;
        }

        const unitById = this.buildAllocationDuhUnitMap(directChildRelations);
        const useOutgoingReports = outgoingAllocationReports.length > 0;
        const sourceMaterialByUnitMaterial = this.buildAllocationDuhSourceMaterialMap(
            useOutgoingReports ? outgoingAllocationReports : requisitionReports,
            useOutgoingReports
        );

        const standardGroupIds = Array.from(new Set(
            Array.from(sourceMaterialByUnitMaterial.values())
                .map((material) => material.standardGroupId)
                .filter((groupId): groupId is string => !isEmptyish(groupId))
        ));

        const standardGroupMaterials = await this.repository.fetchStandardGroupMaterials(standardGroupIds);
        const standardGroupMaterialsByGroupId = new Map<string, StandardGroupMaterialRow[]>();

        for (const mapping of standardGroupMaterials) {
            standardGroupMaterialsByGroupId.set(mapping.groupId, [
                ...(standardGroupMaterialsByGroupId.get(mapping.groupId) ?? []),
                mapping,
            ]);
        }

        const rows = allocationChanges.filter(change =>
            change.quantity !== 0
        ).flatMap((change) => {
            const unit = unitById.get(change.unitId);
            const material = sourceMaterialByUnitMaterial.get(`${change.unitId}:${change.materialId}`);

            if (!unit || !material) {
                return [];
            }

            const standardGroupMappings = material.standardGroupId
                ? standardGroupMaterialsByGroupId.get(material.standardGroupId) ?? []
                : [];
            const oneToOneGroupMaterial = standardGroupMappings.length === 1
                ? standardGroupMappings[0]
                : null;

            return [{
                materialId: oneToOneGroupMaterial?.materialId ?? material.materialId,
                materialDescription: oneToOneGroupMaterial?.materialDescription ?? material.materialDescription,
                quantity: Number(change.quantity ?? 0),
                unitOfMeasure: oneToOneGroupMaterial?.unitOfMeasurement ?? material.unitOfMeasure,
                unitLevelId: unit.unitLevelId,
                unitSimul: unit.simul,
                unitDescription: unit.description,
            }];
        });

        if (rows.length === 0) {
            return null;
        }

        return {
            fileName: `נתוני דו״ה ${date}.xlsx`,
            rows: aggregateAllocationDuhRows(rows),
            groupConversions: standardGroupMaterials.map((mapping) => ({
                groupId: mapping.groupId,
                groupDescription: mapping.groupDescription,
                materialId: mapping.materialId,
                materialDescription: mapping.materialDescription,
            })),
        };
    }

    async fetchAllocationDuhExport(
        date: string,
        screenUnitId: number,
        materialId?: string,
    ): Promise<AllocationDuhExportDto | null> {
        const unitDetails = await this.unitRepository.fetchActiveUnitDetails(date, screenUnitId);

        const [directChildRelations, matkalStatus] = await Promise.all([
            this.unitHierarchyService.fetchLowerUnits(date, screenUnitId) as Promise<UnitRelation[]>,
            this.unitHierarchyService.fetchUnitStatusForDate(screenUnitId, date),
        ]);
        const directChildIds = sortNumeric(directChildRelations.map((relation) => relation.relatedUnitId));

        const [outgoingAllocationReports, requisitionReports] = await Promise.all([
            this.repository.fetchOutgoingAllocationReports(
                date,
                screenUnitId,
                directChildIds,
                materialId ? [materialId] : []
            ),
            directChildIds.length === 0
                ? Promise.resolve([])
                : this.repository.fetchReportsForRecipientsByType(
                    date,
                    REPORT_TYPES.REQUEST,
                    [screenUnitId],
                    directChildIds,
                    materialId ? [materialId] : []
                )
        ]);

        const allocationChanges = buildDownloadAllocationChanges({
            isMatkal: true,
            matkalStatusId: matkalStatus?.unitStatusId,
            outgoingAllocationReports,
            requisitionReports,
            isDvhExcel: true
        });

        return this.buildAllocationDuhExport({
            date,
            allocationChanges,
            directChildRelations,
            outgoingAllocationReports,
            requisitionReports,
        });
    }

    async saveAllocations(
        saveAllocationsDTO: SaveAllocationsDTO,
        date: string,
        screenUnitId: number,
        username: string,
    ) {
        const transaction = await this.sequelize.transaction();
        const { formattedTime } = formatDate(new Date());

        try {
            const unitDetails = await this.unitRepository.fetchActiveUnitDetails(date, screenUnitId);
            const reportsToSave: IReportsChanges[] = buildAllocationsChanges({
                changes: saveAllocationsDTO.changes,
                username,
                creationTime: formattedTime,
                screenUnit: unitDetails!,
                screenDate: new Date(date)
            });

            await this.repository.saveReports({
                reportsToSave,
                transaction,
                fieldsToUpdate: ["reportedQuantity"],
            });

            await transaction.commit();
            return {
                type: MESSAGE_TYPES.SUCCESS,
                message: "הקצאות נשמרו בהצלחה"
            };
        } catch (error: any) {
            await transaction.rollback();

            throw new BadGatewayException({
                message: error?.response?.message ?? 'נכשלה שמירת ההקצאות, יש לנסות שוב',
                type: MESSAGE_TYPES.FAILURE
            })
        }
    }

    async downloadAllocations(
        date: string,
        screenUnitId: number,
        username: string,
        materialId?: string,
    ) {
        const transaction = await this.sequelize.transaction();
        const { formattedTime } = formatDate(new Date());

        try {
            const unitDetails = await this.unitRepository.fetchActiveUnitDetails(date, screenUnitId);
            const [activeRelations, matkalStatus] = await Promise.all([
                this.unitHierarchyService.fetchActiveRelations(date) as Promise<UnitRelation[]>,
                unitDetails?.unitLevelId === UNIT_LEVELS.MATKAL
                    ? this.unitHierarchyService.fetchUnitStatusForDate(screenUnitId, date)
                    : Promise.resolve(null)
            ]);
            const childIdsByParent = buildChildIdsByParent(activeRelations);
            const unitLevelById = buildUnitLevelById(activeRelations);
            const directChildIds = sortNumeric(childIdsByParent.get(screenUnitId) ?? []);
            const directChildRelations = activeRelations.filter((relation) => relation.unitId === screenUnitId);

            const [existingMatkalOutgoingAllocationReports, currentOutgoingAllocationReports, matkalRequisitionReports] = await Promise.all([
                unitDetails?.unitLevelId === UNIT_LEVELS.MATKAL
                    ? this.repository.fetchOutgoingAllocationReports(
                        date,
                        screenUnitId,
                        directChildIds
                    )
                    : Promise.resolve([]),
                this.repository.fetchOutgoingAllocationReports(
                    date,
                    screenUnitId,
                    directChildIds,
                    materialId ? [materialId] : []
                ),
                unitDetails?.unitLevelId === UNIT_LEVELS.MATKAL && directChildIds.length > 0
                    ? this.repository.fetchReportsForRecipientsByType(
                        date,
                        REPORT_TYPES.REQUEST,
                        [screenUnitId],
                        directChildIds,
                        materialId ? [materialId] : []
                    )
                    : Promise.resolve([])
            ]);

            const allocationChanges = buildDownloadAllocationChanges({
                isMatkal: unitDetails?.unitLevelId === UNIT_LEVELS.MATKAL,
                matkalStatusId: matkalStatus?.unitStatusId,
                outgoingAllocationReports: currentOutgoingAllocationReports,
                requisitionReports: matkalRequisitionReports,
                isDvhExcel: false
            });
            const shouldReturnInitialMatkalDuhExport = unitDetails?.unitLevelId === UNIT_LEVELS.MATKAL
                && existingMatkalOutgoingAllocationReports.length === 0;

            if (allocationChanges.length === 0) {
                await transaction.commit();
                return {
                    data: null,
                    type: MESSAGE_TYPES.WARNING,
                    message: "אין הקצאות להורדה"
                };
            }

            const allocatedMaterialIds = Array.from(new Set(allocationChanges.map((change) => change.materialId)));
            const grandchildIds = Array.from(new Set(
                directChildIds.flatMap((childUnitId) => childIdsByParent.get(childUnitId) ?? [])
            ));

            const [incomingAllocationReports, downstreamRequisitionReports] = await Promise.all([
                unitDetails?.unitLevelId === UNIT_LEVELS.MATKAL
                    ? Promise.resolve([])
                    : this.repository.fetchIncomingAllocationReports(date, screenUnitId, allocatedMaterialIds),
                directChildIds.length === 0 || grandchildIds.length === 0
                    ? Promise.resolve([])
                    : this.repository.fetchReportsForRecipientsByType(
                        date,
                        REPORT_TYPES.REQUEST,
                        directChildIds,
                        grandchildIds,
                        allocatedMaterialIds
                    )
            ]);

            const confirmedAllocationReports: IReportsChanges[] = buildConfirmedAllocationChanges({
                changes: allocationChanges,
                username,
                creationTime: formattedTime,
                screenUnit: unitDetails!,
                screenDate: new Date(date)
            });

            const incomingBalanceUpdates = buildAllocationBalanceUpdates({
                allocationChanges,
                incomingAllocationReports,
                username,
                creationTime: formattedTime,
            });

            const nextLevelDraftReports = buildNextLevelAllocationDraftChanges({
                changes: allocationChanges,
                childIdsByParent,
                username,
                creationTime: formattedTime,
                screenDate: new Date(date),
                unitLevelById,
                requisitionReports: downstreamRequisitionReports,
            });

            await this.repository.saveReports({
                reportsToSave: [
                    ...confirmedAllocationReports,
                    ...incomingBalanceUpdates,
                ],
                transaction,
                fieldsToUpdate: ["reportedQuantity", "confirmedQuantity", "balanceQuantity"],
            });

            await this.repository.saveReports({
                reportsToSave: nextLevelDraftReports,
                transaction,
                fieldsToUpdate: ["reportedQuantity"],
            });

            await this.unitStatusService.updateHierarchyStatusesInTransaction({
                unitsIds: directChildIds,
                statusId: UNIT_STATUSES.WAITING_FOR_ALLOCATION,
                updateHierarchy: true
            }, date, transaction);

            await this.unitStatusService.updateHierarchyStatusesInTransaction({
                unitsIds: [...directChildIds, screenUnitId],
                statusId: UNIT_STATUSES.ALLOCATING,
                updateHierarchy: false
            }, date, transaction);

            const allocationDuhExport = shouldReturnInitialMatkalDuhExport
                ? await this.buildAllocationDuhExport({
                    date,
                    allocationChanges,
                    directChildRelations,
                    outgoingAllocationReports: currentOutgoingAllocationReports,
                    requisitionReports: matkalRequisitionReports,
                })
                : null;

            await transaction.commit();

            let downloadAllocationDuhExport: AllocationDuhExportDto | null = null;
            try {
                downloadAllocationDuhExport = await this.fetchAllocationDuhExport(date, screenUnitId, materialId);
            } catch (error) {
                this.logger.error("Failed to build allocation DUH export", error instanceof Error ? error.stack : String(error));
            }

            return {
                data: {
                    allocationDuhExport,
                    downloadAllocationDuhExport,
                },
                type: MESSAGE_TYPES.SUCCESS,
                message: "הקצאות הורדו בהצלחה",
            };
        } catch (error: any) {
            await transaction.rollback();

            throw new BadGatewayException({
                message: error?.response?.message ?? 'נכשלה הורדת ההקצאות, יש לנסות שוב',
                type: MESSAGE_TYPES.FAILURE
            })
        }
    }
}
