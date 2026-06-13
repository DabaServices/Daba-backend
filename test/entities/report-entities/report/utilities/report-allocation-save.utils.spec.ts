import { RECORD_STATUS, UNIT_STATUSES } from "../../../../../src/constants";
import {
    buildAllocationBalanceUpdates,
    buildDownloadAllocationChanges,
    buildAllocationChangesFromReports,
    buildConfirmedAllocationChanges,
    buildAllocationChangesFromRequisitionReports,
    buildNextLevelAllocationDraftChanges,
    mergeMatkalRequisitionAllocations,
} from "../../../../../src/entities/report-entities/report/utilities/report-allocation-save.utils";

describe("report-allocation-save utils", () => {
    it("merges missing matkal allocations from requisitions without overriding explicit changes", () => {
        const changes = [{
            unitId: 10,
            materialId: "A",
            quantity: 4,
        }];

        const merged = mergeMatkalRequisitionAllocations(changes, [{
            unitId: 10,
            recipientUnitId: 1,
            items: [
                { materialId: "A", confirmedQuantity: 8 },
                { materialId: "B", confirmedQuantity: 3 },
                { materialId: "C", confirmedQuantity: 5, status: RECORD_STATUS.INACTIVE },
            ],
        }] as any);

        expect(merged).toEqual([
            { unitId: 10, materialId: "A", quantity: 4 },
            { unitId: 10, materialId: "B", quantity: 3 },
        ]);
    });

    it("stores confirmed allocations with reset draft and initial balance", () => {
        const reports = buildConfirmedAllocationChanges({
            changes: [{
                unitId: 10,
                materialId: "A",
                quantity: 7,
            }],
            username: "tester",
            creationTime: "10:00:00",
            screenDate: new Date("2026-03-29"),
            screenUnit: { unitId: 1, unitLevelId: 0 },
        });

        expect(reports).toHaveLength(1);
        expect(reports[0].header.unitId).toBe(1);
        expect(reports[0].header.recipientUnitId).toBe(10);
        expect(reports[0].items).toEqual([
            expect.objectContaining({
                materialId: "A",
                reportedQuantity: 0,
                confirmedQuantity: 7,
                balanceQuantity: 7,
                reportingUnitId: 1,
                reportingLevel: 0,
            }),
        ]);
    });

    it("uses requisition quantity for matkal confirmed and balance values", () => {
        const changes = buildAllocationChangesFromRequisitionReports([{
            unitId: 10,
            recipientUnitId: 1,
            items: [{ materialId: "A", confirmedQuantity: 9 }],
        }] as any);

        const reports = buildConfirmedAllocationChanges({
            changes,
            username: "tester",
            creationTime: "10:00:00",
            screenDate: new Date("2026-03-29"),
            screenUnit: { unitId: 1, unitLevelId: 0 },
        });

        expect(reports[0].items[0]).toEqual(expect.objectContaining({
            materialId: "A",
            confirmedQuantity: 9,
            balanceQuantity: 9,
        }));
    });

    it("prefers matkal allocation reports over requisitions when allocation records exist", () => {
        const changes = buildDownloadAllocationChanges({
            isMatkal: true,
            matkalStatusId: UNIT_STATUSES.WAITING_FOR_ALLOCATION,
            outgoingAllocationReports: [{
                unitId: 1,
                recipientUnitId: 10,
                items: [{
                    materialId: "A",
                    reportedQuantity: 6,
                    confirmedQuantity: 10,
                    balanceQuantity: 8,
                }],
            }] as any,
            requisitionReports: [{
                unitId: 10,
                recipientUnitId: 1,
                items: [{ materialId: "A", confirmedQuantity: 20 }],
            }] as any,
            isDvhExcel: false
        });

        expect(changes).toEqual([{
            unitId: 10,
            materialId: "A",
            quantity: 6,
            existingConfirmedQuantity: 10,
            existingBalanceQuantity: 8,
        }]);
    });

    it("prefers saved Matkal allocations over requisitions while still requesting", () => {
        const changes = buildDownloadAllocationChanges({
            isMatkal: true,
            matkalStatusId: UNIT_STATUSES.REQUESTING,
            outgoingAllocationReports: [{
                unitId: 1,
                recipientUnitId: 10,
                items: [{
                    materialId: "allocated-material",
                    reportedQuantity: 5,
                }],
            }] as any,
            requisitionReports: [{
                unitId: 10,
                recipientUnitId: 1,
                items: [{
                    materialId: "allocated-material",
                    confirmedQuantity: 5,
                }, {
                    materialId: "unallocated-material",
                    confirmedQuantity: 9,
                }],
            }] as any,
            isDvhExcel: false,
        });

        expect(changes).toEqual([{
            unitId: 10,
            materialId: "allocated-material",
            quantity: 5,
            existingConfirmedQuantity: 0,
            existingBalanceQuantity: 0,
        }]);
    });

    it("adds reset draft quantity to existing confirmed and balance allocation values", () => {
        const changes = buildAllocationChangesFromReports([{
            unitId: 1,
            recipientUnitId: 10,
            items: [{
                materialId: "A",
                reportedQuantity: 6,
                confirmedQuantity: 10,
                balanceQuantity: 8,
            }],
        }] as any);

        const reports = buildConfirmedAllocationChanges({
            changes,
            username: "tester",
            creationTime: "10:00:00",
            screenDate: new Date("2026-03-29"),
            screenUnit: { unitId: 1, unitLevelId: 0 },
        });

        expect(reports[0].items[0]).toEqual(expect.objectContaining({
            materialId: "A",
            reportedQuantity: 0,
            confirmedQuantity: 16,
            balanceQuantity: 14,
        }));
    });

    it("does not create Matkal allocations from inactive requisition items", () => {
        const changes = buildDownloadAllocationChanges({
            isMatkal: true,
            matkalStatusId: UNIT_STATUSES.REQUESTING,
            outgoingAllocationReports: [],
            requisitionReports: [{
                unitId: 10,
                recipientUnitId: 1,
                items: [{
                    materialId: "inactive-material",
                    confirmedQuantity: 5,
                    reportedQuantity: 5,
                    status: RECORD_STATUS.INACTIVE,
                }, {
                    materialId: "active-material",
                    confirmedQuantity: 7,
                    reportedQuantity: 7,
                    status: RECORD_STATUS.ACTIVE,
                }],
            }] as any,
            isDvhExcel: false,
        });

        expect(changes).toEqual([{
            unitId: 10,
            materialId: "active-material",
            quantity: 7,
        }]);
    });

    it("seeds next-level drafts from requisitions and defaults to zero", () => {
        const reports = buildNextLevelAllocationDraftChanges({
            changes: [{
                unitId: 10,
                materialId: "A",
                quantity: 7,
            }],
            childIdsByParent: new Map([[10, [100, 101]]]),
            username: "tester",
            creationTime: "10:00:00",
            screenDate: new Date("2026-03-29"),
            unitLevelById: new Map([[10, 1]]),
            requisitionReports: [{
                unitId: 100,
                recipientUnitId: 10,
                items: [
                    { materialId: "A", confirmedQuantity: 5 },
                    { materialId: "B", confirmedQuantity: 3, status: RECORD_STATUS.INACTIVE },
                ],
            }] as any,
        });

        expect(reports).toHaveLength(2);
        expect(reports[0].items[0]).toEqual(expect.objectContaining({
            materialId: "A",
            reportedQuantity: 5,
            reportingUnitId: 10,
            reportingLevel: 1,
        }));
        expect(reports[1].items[0]).toEqual(expect.objectContaining({
            materialId: "A",
            reportedQuantity: 0,
        }));
        expect(reports[0].items).toHaveLength(1);
        expect(reports[1].items).toHaveLength(1);
    });

    it("subtracts allocations from incoming allocation balances while preserving confirmed quantity", () => {
        const reports = buildAllocationBalanceUpdates({
            allocationChanges: [{
                unitId: 10,
                materialId: "A",
                quantity: 6,
            }],
            incomingAllocationReports: [{
                reportTypeId: 4,
                unitId: 1,
                recipientUnitId: 2,
                reporterUnitId: 1,
                createdOn: new Date("2026-03-29"),
                createdBy: "parent",
                createdAt: "09:00:00",
                items: [{
                    materialId: "A",
                    reportedQuantity: 0,
                    confirmedQuantity: 10,
                    balanceQuantity: 8,
                    reportingLevel: 0,
                    reportingUnitId: 1,
                    status: "ACTIVE",
                }],
            }] as any,
            username: "tester",
            creationTime: "10:00:00",
        });

        expect(reports).toHaveLength(1);
        expect(reports[0].items).toEqual([
            expect.objectContaining({
                materialId: "A",
                confirmedQuantity: 10,
                balanceQuantity: 2,
            }),
        ]);
    });
});
