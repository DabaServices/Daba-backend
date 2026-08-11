import { REPORT_TYPES } from "../../../constants";
import type { ValidExcelRow } from "./excel.types";
import { filterRegularUnitRequisitions } from "./excel.service";

const buildRow = (reportType: number, unitId: number): ValidExcelRow => ({
    reportType,
    unitId,
    unitSimul: String(unitId),
    materialId: "material-1",
    quantity: 1,
    rowNumber: unitId,
});

describe("filterRegularUnitRequisitions", () => {
    it("discards requisitions for regular units while preserving emergency requisitions and other report types", () => {
        const rows = [
            buildRow(REPORT_TYPES.REQUEST, 10),
            buildRow(REPORT_TYPES.REQUEST, 20),
            buildRow(REPORT_TYPES.INVENTORY, 10),
            buildRow(REPORT_TYPES.USAGE, 10),
        ];

        expect(filterRegularUnitRequisitions(rows, new Set([20]))).toEqual([
            buildRow(REPORT_TYPES.REQUEST, 20),
            buildRow(REPORT_TYPES.INVENTORY, 10),
            buildRow(REPORT_TYPES.USAGE, 10),
        ]);
    });
});