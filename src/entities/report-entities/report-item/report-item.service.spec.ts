import { UNIT_LEVELS, UNIT_STATUSES } from "../../../constants";
import type { IReportItem } from "./report-item.model";
import { ReportItemRepository } from "./report-item.repository";
import { ReportItemService } from "./report-item.service";
import type { UnitRepository } from "src/entities/unit-entities/unit/unit.repository";
import type { UnitStatusRepository } from "src/entities/unit-entities/units-statuses/units-statuses.repository";
import type { Sequelize } from "sequelize-typescript";

const date = "2026-08-11";

const buildAllocationItem = (materialId: string, balanceQuantity: number): IReportItem => ({
    reportId: materialId === "material-1" ? 1 : 2,
    materialId,
    reportingLevel: UNIT_LEVELS.MATKAL,
    reportingUnitId: 10,
    reportingUnitObjectType: "U",
    confirmedQuantity: balanceQuantity,
    balanceQuantity,
});

const buildReport = (item: IReportItem) => ({
    items: [{ dataValues: item }],
});

const buildService = () => {
    const repository = {
        fetchReports: jest.fn(),
        updateReportsItems: jest.fn(),
    };
    const unitRepository = {
        fetchActiveUnitDetails: jest.fn().mockResolvedValue({ unitLevelId: UNIT_LEVELS.MATKAL }),
    };
    const unitStatusRepository = {
        updateStatuses: jest.fn(),
    };
    const transaction = {
        commit: jest.fn(),
        rollback: jest.fn(),
    };
    const sequelize = {
        transaction: jest.fn().mockResolvedValue(transaction),
    };

    return {
        repository,
        unitStatusRepository,
        transaction,
        service: new ReportItemService(
            repository as unknown as ReportItemRepository,
            unitRepository as unknown as UnitRepository,
            unitStatusRepository as unknown as UnitStatusRepository,
            sequelize as unknown as Sequelize,
        ),
    };
};

describe("ReportItemService", () => {
    it("keeps the unit status when another allocation item still has a balance", async () => {
        const { repository, service, unitStatusRepository } = buildService();
        const consumedItem = buildAllocationItem("material-1", 5);
        const outstandingItem = buildAllocationItem("material-2", 3);

        repository.fetchReports
            .mockResolvedValueOnce([buildReport(consumedItem)])
            .mockResolvedValueOnce([buildReport(consumedItem), buildReport(outstandingItem)]);

        await service.eatAllocation({
            date,
            materialId: "material-1",
            quantity: 5,
            screenUnitId: 10,
            unitId: 20,
        });

        expect(unitStatusRepository.updateStatuses).not.toHaveBeenCalled();
    });

    it("changes the unit status after every allocation item balance reaches zero", async () => {
        const { repository, service, transaction, unitStatusRepository } = buildService();
        const consumedItem = buildAllocationItem("material-1", 5);
        const depletedItem = buildAllocationItem("material-2", 0);

        repository.fetchReports
            .mockResolvedValueOnce([buildReport(consumedItem)])
            .mockResolvedValueOnce([buildReport(consumedItem), buildReport(depletedItem)]);

        await service.eatAllocation({
            date,
            materialId: "material-1",
            quantity: 5,
            screenUnitId: 10,
            unitId: 20,
        });

        expect(unitStatusRepository.updateStatuses).toHaveBeenCalledWith([
            {
                date: new Date(date),
                unitId: 20,
                unitStatusId: UNIT_STATUSES.WAITING_FOR_ALLOCATION,
            },
        ], transaction);
    });
});