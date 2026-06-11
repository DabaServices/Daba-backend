import { RECORD_STATUS, REPORT_TYPES, UNIT_LEVELS, UNIT_STATUSES } from "../../../../constants";
import type { AggregateUnitDto, UnitDto } from "../report.types";
import { getAggregatedReports } from "./report-aggregate-hierarchy.utils";

const buildParent = (id: number, level: number): UnitDto => ({
    id,
    description: `Unit ${id}`,
    level,
    simul: String(id),
    status: {
        id: UNIT_STATUSES.REQUESTING,
        description: "בדיווח",
    },
    parent: null,
});

const buildUnit = (
    id: number,
    level: number,
    parent: UnitDto | null = null
): AggregateUnitDto => ({
    id,
    description: `Unit ${id}`,
    level,
    simul: String(id),
    status: {
        id: UNIT_STATUSES.REQUESTING,
        description: "בדיווח",
    },
    isEmergencyUnit: level === UNIT_LEVELS.GDUD,
    parent,
});

const buildReport = ({
    unitId,
    recipientUnitId,
    reportTypeId,
    quantity,
    status,
    materialMultiply,
}: {
    unitId: number;
    recipientUnitId: number;
    reportTypeId: number;
    quantity: number;
    status: string;
    materialMultiply?: number;
}) => ({
    unitId,
    recipientUnitId,
    reportTypeId,
    items: [{
        materialId: "M-1",
        confirmedQuantity: quantity,
        reportedQuantity: quantity,
        status,
        material: isNaN(Number(materialMultiply))
            ? undefined
            : {
                multiply: materialMultiply,
            },
    }],
});

describe("getAggregatedReports", () => {
    it("marks the parent aggregated item inactive when a higher level deletes a child-aggregated material", async () => {
        const screenUnit = buildUnit(1, UNIT_LEVELS.PIKUD);
        const higherLevelUnit = buildUnit(2, UNIT_LEVELS.UGDA, buildParent(1, UNIT_LEVELS.PIKUD));
        const gdudUnit = buildUnit(3, UNIT_LEVELS.GDUD, buildParent(2, UNIT_LEVELS.UGDA));

        const reportsToSave = await getAggregatedReports({
            date: "2026-04-23",
            unitsToLaunch: [2],
            screenUnitId: 1,
            unitsMap: {
                1: screenUnit,
                2: higherLevelUnit,
                3: gdudUnit,
            },
            childrenByParentMap: {
                1: [higherLevelUnit],
                2: [gdudUnit],
            },
            dbReports: [
                buildReport({
                    unitId: 3,
                    recipientUnitId: 2,
                    reportTypeId: REPORT_TYPES.USAGE,
                    quantity: 5,
                    status: RECORD_STATUS.ACTIVE,
                }),
                buildReport({
                    unitId: 2,
                    recipientUnitId: 1,
                    reportTypeId: REPORT_TYPES.USAGE,
                    quantity: 5,
                    status: RECORD_STATUS.INACTIVE,
                }),
            ] as any,
            username: "tester",
            isLaunching: false,
        });

        const higherLevelUsageReport = reportsToSave.find((report) =>
            report.header.unitId === 2
            && report.header.recipientUnitId === 1
            && report.header.reportTypeId === REPORT_TYPES.USAGE
        );

        expect(higherLevelUsageReport?.items).toEqual([
            expect.objectContaining({
                materialId: "M-1",
                confirmedQuantity: 5,
                reportedQuantity: 5,
                status: RECORD_STATUS.INACTIVE,
            }),
        ]);
    });

    it("keeps a higher-level active material in the aggregated output even without child source rows", async () => {
        const screenUnit = buildUnit(1, UNIT_LEVELS.PIKUD);
        const higherLevelUnit = buildUnit(2, UNIT_LEVELS.UGDA, buildParent(1, UNIT_LEVELS.PIKUD));

        const reportsToSave = await getAggregatedReports({
            date: "2026-04-23",
            unitsToLaunch: [2],
            screenUnitId: 1,
            unitsMap: {
                1: screenUnit,
                2: higherLevelUnit,
            },
            childrenByParentMap: {
                1: [higherLevelUnit],
            },
            dbReports: [
                buildReport({
                    unitId: 2,
                    recipientUnitId: 1,
                    reportTypeId: REPORT_TYPES.USAGE,
                    quantity: 7,
                    status: RECORD_STATUS.ACTIVE,
                }),
            ] as any,
            username: "tester",
            isLaunching: false,
        });

        const higherLevelUsageReport = reportsToSave.find((report) =>
            report.header.unitId === 2
            && report.header.recipientUnitId === 1
            && report.header.reportTypeId === REPORT_TYPES.USAGE
        );

        expect(higherLevelUsageReport?.items).toEqual([
            expect.objectContaining({
                materialId: "M-1",
                confirmedQuantity: 7,
                reportedQuantity: 7,
                status: RECORD_STATUS.ACTIVE,
            }),
        ]);
    });

    it("rounds aggregated requisition quantities to the nearest material multiply", async () => {
        const screenUnit = buildUnit(1, UNIT_LEVELS.PIKUD);
        const higherLevelUnit = buildUnit(2, UNIT_LEVELS.UGDA, buildParent(1, UNIT_LEVELS.PIKUD));
        const gdudUnitA = buildUnit(3, UNIT_LEVELS.GDUD, buildParent(2, UNIT_LEVELS.UGDA));
        const gdudUnitB = buildUnit(4, UNIT_LEVELS.GDUD, buildParent(2, UNIT_LEVELS.UGDA));

        const reportsToSave = await getAggregatedReports({
            date: "2026-04-23",
            unitsToLaunch: [2],
            screenUnitId: 1,
            unitsMap: {
                1: screenUnit,
                2: higherLevelUnit,
                3: gdudUnitA,
                4: gdudUnitB,
            },
            childrenByParentMap: {
                1: [higherLevelUnit],
                2: [gdudUnitA, gdudUnitB],
            },
            dbReports: [
                buildReport({
                    unitId: 3,
                    recipientUnitId: 2,
                    reportTypeId: REPORT_TYPES.REQUEST,
                    quantity: 8,
                    status: RECORD_STATUS.ACTIVE,
                    materialMultiply: 5,
                }),
                buildReport({
                    unitId: 4,
                    recipientUnitId: 2,
                    reportTypeId: REPORT_TYPES.REQUEST,
                    quantity: 8,
                    status: RECORD_STATUS.ACTIVE,
                    materialMultiply: 5,
                }),
            ] as any,
            username: "tester",
            isLaunching: false,
        });

        const higherLevelRequestReport = reportsToSave.find((report) =>
            report.header.unitId === 2
            && report.header.recipientUnitId === 1
            && report.header.reportTypeId === REPORT_TYPES.REQUEST
        );

        expect(higherLevelRequestReport?.items).toEqual([
            expect.objectContaining({
                materialId: "M-1",
                confirmedQuantity: 15,
                reportedQuantity: 15,
                status: RECORD_STATUS.ACTIVE,
            }),
        ]);
    });

    it("does not round non-requisition aggregated quantities by material multiply", async () => {
        const screenUnit = buildUnit(1, UNIT_LEVELS.PIKUD);
        const higherLevelUnit = buildUnit(2, UNIT_LEVELS.UGDA, buildParent(1, UNIT_LEVELS.PIKUD));
        const gdudUnitA = buildUnit(3, UNIT_LEVELS.GDUD, buildParent(2, UNIT_LEVELS.UGDA));
        const gdudUnitB = buildUnit(4, UNIT_LEVELS.GDUD, buildParent(2, UNIT_LEVELS.UGDA));

        const reportsToSave = await getAggregatedReports({
            date: "2026-04-23",
            unitsToLaunch: [2],
            screenUnitId: 1,
            unitsMap: {
                1: screenUnit,
                2: higherLevelUnit,
                3: gdudUnitA,
                4: gdudUnitB,
            },
            childrenByParentMap: {
                1: [higherLevelUnit],
                2: [gdudUnitA, gdudUnitB],
            },
            dbReports: [
                buildReport({
                    unitId: 3,
                    recipientUnitId: 2,
                    reportTypeId: REPORT_TYPES.USAGE,
                    quantity: 8,
                    status: RECORD_STATUS.ACTIVE,
                    materialMultiply: 5,
                }),
                buildReport({
                    unitId: 4,
                    recipientUnitId: 2,
                    reportTypeId: REPORT_TYPES.USAGE,
                    quantity: 8,
                    status: RECORD_STATUS.ACTIVE,
                    materialMultiply: 5,
                }),
            ] as any,
            username: "tester",
            isLaunching: false,
        });

        const higherLevelUsageReport = reportsToSave.find((report) =>
            report.header.unitId === 2
            && report.header.recipientUnitId === 1
            && report.header.reportTypeId === REPORT_TYPES.USAGE
        );

        expect(higherLevelUsageReport?.items).toEqual([
            expect.objectContaining({
                materialId: "M-1",
                confirmedQuantity: 16,
                reportedQuantity: 16,
                status: RECORD_STATUS.ACTIVE,
            }),
        ]);
    });
});
