import { REPORT_TYPES } from "../../../../constants";
import { buildReportsResponse } from "./report-fetch.utils";

const buildComment = (
    unitId: number,
    recipientUnitId: number,
    text: string,
    type?: number,
    materialId?: string
) => ({
    dataValues: {
        unitId,
        recipientUnitId,
        text,
        type,
        materialId,
    },
});

const buildUnitAssociation = (id: number, description: string) => ({
    details: [{
        unitId: id,
        description,
        unitLevelId: 1,
        tsavIrgunCodeId: String(id),
    }],
    unitStatus: [{
        unitStatus: {
            id: 1,
            description: "בדיווח",
        },
    }],
});

describe("buildReportsResponse", () => {
    it("excludes the screen unit from items and returns its parent-scoped comment in comments", () => {
        const data = buildReportsResponse({
            screenUnitId: 35,
            reports: [{
                unitId: 35,
                recipientUnitId: 1,
                reportTypeId: REPORT_TYPES.USAGE,
                unit: buildUnitAssociation(35, "Unit 35"),
                recipientUnit: buildUnitAssociation(1, "Parent Unit"),
                items: [{
                    materialId: "M0000001",
                    confirmedQuantity: 2,
                    status: "ACTIVE",
                    material: {
                        id: "M0000001",
                        comments: [
                            buildComment(35, 1, "screen unit comment"),
                        ],
                    },
                }],
            }] as any,
        });

        expect(data).toEqual([{
            material: {
                id: "M0000001",
                description: "",
                multiply: 0,
                nickname: "",
                category: "כללי",
                unitOfMeasure: "יח",
                type: "ITEM",
            },
            comments: [{
                type: REPORT_TYPES.USAGE,
                comment: "screen unit comment",
            }],
            receivedAllocationQuantity: null,
            quantityLeftToAllocate: null,
            items: [],
        }]);
    });

    it("keeps child unit rows in items", () => {
        const data = buildReportsResponse({
            screenUnitId: 35,
            reports: [{
                unitId: 100,
                recipientUnitId: 35,
                reportTypeId: REPORT_TYPES.USAGE,
                unit: buildUnitAssociation(100, "Unit 100"),
                recipientUnit: buildUnitAssociation(35, "Unit 35"),
                items: [{
                    materialId: "M0000001",
                    confirmedQuantity: 2,
                    status: "ACTIVE",
                    material: {
                        id: "M0000001",
                        comments: [
                            buildComment(100, 35, "child comment"),
                        ],
                    },
                }],
            }] as any,
        });

        expect(data).toHaveLength(1);
        expect(data[0].comments).toEqual([]);
        expect(data[0].items).toHaveLength(1);
        expect(data[0].items[0].unit.id).toBe(100);
        expect(data[0].items[0].types[0].comment).toBe("child comment");
        expect(data[0].quantityLeftToAllocate).toBeNull();
        expect(data[0].items[0].allocatedQuantity).toBeNull();
    });

    it("maps allocation reports to the recipient unit and keeps the allocation comment on the item type", () => {
        const data = buildReportsResponse({
            screenUnitId: 35,
            reports: [{
                unitId: 35,
                recipientUnitId: 100,
                reportTypeId: REPORT_TYPES.ALLOCATION,
                unit: buildUnitAssociation(35, "Unit 35"),
                recipientUnit: buildUnitAssociation(100, "Unit 100"),
                items: [{
                    materialId: "M0000001",
                    reportedQuantity: 7,
                    confirmedQuantity: 10,
                    status: "ACTIVE",
                    material: {
                        id: "M0000001",
                        comments: [
                            buildComment(35, 100, "allocation comment"),
                        ],
                    },
                }],
            }] as any,
        });

        expect(data).toHaveLength(1);
        expect(data[0].comments).toEqual([]);
        expect(data[0].items).toHaveLength(1);
        expect(data[0].items[0].unit.id).toBe(100);
        expect(data[0].items[0].unit.parent?.id).toBe(35);
        expect(data[0].items[0].unit.parent?.parent).toBeNull();
        expect(data[0].items[0].allocatedQuantity).toBe(10);
        expect(data[0].items[0].types[0].quantity).toBe(7);
        expect(data[0].items[0].types[0].comment).toBe("allocation comment");
        expect(data[0].items[0].types[0]).not.toHaveProperty("allocatedQuantity");
    });

    it("does not reuse one allocation comment for every recipient child", () => {
        const allocationComment = buildComment(35, 100, "allocation comment for unit 100");
        const data = buildReportsResponse({
            screenUnitId: 35,
            reports: [{
                unitId: 35,
                recipientUnitId: 100,
                reportTypeId: REPORT_TYPES.ALLOCATION,
                unit: buildUnitAssociation(35, "Unit 35"),
                recipientUnit: buildUnitAssociation(100, "Unit 100"),
                items: [{
                    materialId: "M0000001",
                    reportedQuantity: 7,
                    confirmedQuantity: 10,
                    balanceQuantity: 4,
                    status: "ACTIVE",
                    material: {
                        id: "M0000001",
                        comments: [allocationComment],
                    },
                }],
            }, {
                unitId: 35,
                recipientUnitId: 101,
                reportTypeId: REPORT_TYPES.ALLOCATION,
                unit: buildUnitAssociation(35, "Unit 35"),
                recipientUnit: buildUnitAssociation(101, "Unit 101"),
                items: [{
                    materialId: "M0000001",
                    reportedQuantity: 3,
                    confirmedQuantity: 5,
                    balanceQuantity: 2,
                    status: "ACTIVE",
                    material: {
                        id: "M0000001",
                        comments: [allocationComment],
                    },
                }],
            }] as any,
        });

        const itemByUnitId = new Map(data[0].items.map(item => [item.unit.id, item]));

        expect(itemByUnitId.get(100)?.types[0].comment).toBe("allocation comment for unit 100");
        expect(itemByUnitId.get(101)?.types[0].comment).toBe("");
    });

    it("puts incoming allocation comments on the report comments field", () => {
        const data = buildReportsResponse({
            screenUnitId: 100,
            reports: [{
                unitId: 35,
                recipientUnitId: 100,
                reportTypeId: REPORT_TYPES.ALLOCATION,
                unit: buildUnitAssociation(35, "Unit 35"),
                recipientUnit: buildUnitAssociation(100, "Unit 100"),
                items: [{
                    materialId: "M0000001",
                    reportedQuantity: 7,
                    confirmedQuantity: 10,
                    balanceQuantity: 4,
                    status: "ACTIVE",
                    material: {
                        id: "M0000001",
                        comments: [
                            buildComment(35, 100, "incoming allocation comment"),
                        ],
                    },
                }],
            }] as any,
        });

        expect(data).toHaveLength(1);
        expect(data[0].comments).toEqual([{
            type: REPORT_TYPES.ALLOCATION,
            comment: "incoming allocation comment",
        }]);
        expect(data[0].items[0].types[0].comment).toBe("");
    });

    it("keeps allocation type quantity on reported quantity after reporting resets the draft", () => {
        const data = buildReportsResponse({
            screenUnitId: 35,
            reports: [{
                unitId: 35,
                recipientUnitId: 100,
                reportTypeId: REPORT_TYPES.ALLOCATION,
                unit: buildUnitAssociation(35, "Unit 35"),
                recipientUnit: buildUnitAssociation(100, "Unit 100"),
                items: [{
                    materialId: "M0000001",
                    reportedQuantity: 0,
                    confirmedQuantity: 10,
                    balanceQuantity: 10,
                    status: "ACTIVE",
                    material: {
                        id: "M0000001",
                        comments: [],
                    },
                }],
            }] as any,
        });

        expect(data[0].items[0].allocatedQuantity).toBe(10);
        expect(data[0].items[0].types[0].quantity).toBe(0);
    });

    it("returns allocation comments even when there is no allocation report", () => {
        const data = buildReportsResponse({
            screenUnitId: 35,
            reports: [],
            standaloneComments: [{
                ...buildComment(35, 100, "comment without report", REPORT_TYPES.ALLOCATION, "M0000001"),
                unitId: 35,
                recipientUnitId: 100,
                materialId: "M0000001",
                type: REPORT_TYPES.ALLOCATION,
                text: "comment without report",
                unit: buildUnitAssociation(35, "Unit 35"),
                recipientUnit: buildUnitAssociation(100, "Unit 100"),
                material: {
                    id: "M0000001",
                    description: "Material 1",
                    type: "ITEM",
                },
            }],
        } as any);

        expect(data).toHaveLength(1);
        expect(data[0].material.description).toBe("Material 1");
        expect(data[0].comments).toEqual([]);
        expect(data[0].items).toHaveLength(1);
        expect(data[0].items[0].unit.id).toBe(100);
        expect(data[0].items[0].types[0]).toEqual(expect.objectContaining({
            id: REPORT_TYPES.ALLOCATION,
            quantity: 0,
            comment: "comment without report",
        }));
    });

    it("returns incoming allocation comments in comments even when there is no allocation report", () => {
        const data = buildReportsResponse({
            screenUnitId: 100,
            reports: [],
            standaloneComments: [{
                ...buildComment(35, 100, "incoming comment without report", REPORT_TYPES.ALLOCATION, "M0000001"),
                unitId: 35,
                recipientUnitId: 100,
                materialId: "M0000001",
                type: REPORT_TYPES.ALLOCATION,
                text: "incoming comment without report",
                unit: buildUnitAssociation(35, "Unit 35"),
                recipientUnit: buildUnitAssociation(100, "Unit 100"),
                material: {
                    id: "M0000001",
                    description: "Material 1",
                    type: "ITEM",
                },
            }],
        } as any);

        expect(data).toHaveLength(1);
        expect(data[0].comments).toEqual([{
            type: REPORT_TYPES.ALLOCATION,
            comment: "incoming comment without report",
        }]);
        expect(data[0].items).toEqual([]);
    });

    it("returns the screen unit allocated quantity from incoming allocation confirmed quantity", () => {
        const data = buildReportsResponse({
            screenUnitId: 35,
            reports: [],
            screenAllocationReports: [{
                unitId: 1,
                recipientUnitId: 35,
                reportTypeId: REPORT_TYPES.ALLOCATION,
                items: [{
                    materialId: "M0000001",
                    balanceQuantity: 12,
                    confirmedQuantity: 15,
                    status: "ACTIVE",
                    material: {
                        id: "M0000001",
                        comments: [],
                    },
                }],
            }] as any,
        });

        expect(data).toEqual([{
            material: {
                id: "M0000001",
                description: "",
                multiply: 0,
                nickname: "",
                category: "כללי",
                unitOfMeasure: "יח",
                type: "ITEM",
            },
            comments: [],
            receivedAllocationQuantity: 15,
            quantityLeftToAllocate: 12,
            items: [],
        }]);
    });

    it("builds standard group metadata when the report item points to a standard group", () => {
        const data = buildReportsResponse({
            screenUnitId: 35,
            reports: [{
                unitId: 100,
                recipientUnitId: 35,
                reportTypeId: REPORT_TYPES.USAGE,
                unit: buildUnitAssociation(100, "Unit 100"),
                recipientUnit: buildUnitAssociation(35, "Unit 35"),
                items: [{
                    materialId: "GRP000001",
                    confirmedQuantity: 2,
                    status: "ACTIVE",
                    standardGroup: {
                        id: "GRP000001",
                        name: "Tool Group",
                        groupType: "TOOL",
                        nickname: {
                            nickname: "Group Nickname",
                        },
                        categoryGroup: {
                            categoryDesc: {
                                description: "קטגוריית כלים",
                            },
                        },
                    },
                }],
            }] as any,
        });

        expect(data).toHaveLength(1);
        expect(data[0].material).toEqual({
            id: "GRP000001",
            description: "Tool Group",
            multiply: 0,
            nickname: "Group Nickname",
            category: "קטגוריית כלים",
            unitOfMeasure: "יח",
            type: "TOOL",
        });
    });
});
