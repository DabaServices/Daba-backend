import { BadRequestException, Injectable } from "@nestjs/common";
import { ReportItemRepository } from "./report-item.repository";
import { MESSAGE_TYPES, RECORD_STATUS, REPORT_TYPES, UNIT_LEVELS, UNIT_STATUSES } from "../../../constants";
import { IReportItem } from "./report-item.model";
import { Sequelize } from "sequelize-typescript";
import { DeleteItemsDTO, EatAllocationDTO } from "./report.types";
import { isNullish, round } from "remeda";
import { UnitRepository } from "src/entities/unit-entities/unit/unit.repository";
import { UnitStatusRepository } from "src/entities/unit-entities/units-statuses/units-statuses.repository";

@Injectable()
export class ReportItemService {
    constructor(private readonly repository: ReportItemRepository,
        private readonly unitRepository: UnitRepository,
        private readonly unitStatusRepository: UnitStatusRepository,
        private readonly sequelize: Sequelize
    ) { }

    async eatAllocation(eatAllocation: EatAllocationDTO) {
        const itemsToUpdate: IReportItem[] = [];
        const transaction = await this.sequelize.transaction();

        try {
            const unitDetails = await this.unitRepository.fetchActiveUnitDetails(eatAllocation.date, eatAllocation.screenUnitId);

            const recipientUnitAllocation = await this.repository.fetchReports({
                date: eatAllocation.date,
                materialId: eatAllocation.materialId,
                reportsTypesIds: [REPORT_TYPES.ALLOCATION],
                recipientUnitId: eatAllocation.unitId
            }, transaction);

            const recipientUnitAllocations = await this.repository.fetchReports({
                date: eatAllocation.date,
                reportsTypesIds: [REPORT_TYPES.ALLOCATION],
                recipientUnitId: eatAllocation.unitId
            }, transaction);

            const recipientUnitItem = recipientUnitAllocation?.[0]?.items?.[0]?.dataValues;
            const availableQuantityToEat = round(Number(recipientUnitItem?.balanceQuantity ?? 0), 3);
            const quantityToEat = round(Number(eatAllocation.quantity), 3);

            if (quantityToEat > availableQuantityToEat) {
                throw new BadRequestException({
                    message: `נכשלה אכילת ההקצאה, לא ניתן למשוך יותר מ-${availableQuantityToEat} עבור מק״ט ${eatAllocation.materialId}`,
                    type: MESSAGE_TYPES.FAILURE
                });
            }

            let screenUnitItem: IReportItem | undefined;

            if (unitDetails?.unitLevelId !== UNIT_LEVELS.MATKAL) {
                const screenUnitAllocation = await this.repository.fetchReports({
                    date: eatAllocation.date,
                    materialId: eatAllocation.materialId,
                    reportsTypesIds: [REPORT_TYPES.ALLOCATION],
                    recipientUnitId: eatAllocation.screenUnitId
                }, transaction);

                screenUnitItem = screenUnitAllocation?.[0]?.items?.[0]?.dataValues;

                if (!isNullish(screenUnitItem)) {
                    screenUnitItem.balanceQuantity! = Number(screenUnitItem.balanceQuantity) + Number(eatAllocation.quantity);

                    itemsToUpdate.push(screenUnitItem);
                }
            }

            if (!isNullish(recipientUnitItem)) {
                recipientUnitItem.balanceQuantity = Number(recipientUnitItem.balanceQuantity) - Number(eatAllocation.quantity);
                recipientUnitItem.confirmedQuantity! = Number(recipientUnitItem.confirmedQuantity) - Number(eatAllocation.quantity);

                const recipientAllocationItems = recipientUnitAllocations.flatMap(
                    allocation => allocation.items ?? []
                );
                const allAllocationBalancesAreZero = recipientAllocationItems.length > 0 &&
                    recipientAllocationItems.every(({ dataValues: allocationItem }) => {
                        const isConsumedItem = allocationItem.reportId === recipientUnitItem.reportId &&
                            allocationItem.materialId === recipientUnitItem.materialId &&
                            allocationItem.reportingLevel === recipientUnitItem.reportingLevel;
                        const balanceQuantity = isConsumedItem
                            ? recipientUnitItem.balanceQuantity
                            : allocationItem.balanceQuantity;

                        return Number(balanceQuantity) === 0;
                    });

                if (allAllocationBalancesAreZero) {
                    await this.unitStatusRepository.updateStatuses([{
                        date: new Date(eatAllocation.date),
                        unitId: eatAllocation.unitId,
                        unitStatusId: UNIT_STATUSES.WAITING_FOR_ALLOCATION
                    }], transaction);
                }

                itemsToUpdate.push(recipientUnitItem);
            }

            await this.repository.updateReportsItems(itemsToUpdate, transaction);

            await transaction.commit();
            return {
                message: 'ההקצאה נאכלה בהצלחה',
                type: MESSAGE_TYPES.SUCCESS
            };
        } catch (error) {
            console.log(error);

            await transaction.rollback();

            if (error instanceof BadRequestException) throw error;

            throw new BadRequestException({
                message: 'נכשלה אכילת ההקצאה, יש לנסות שוב',
                type: MESSAGE_TYPES.FAILURE
            });
        }
    }

    async deleteAllAllocations(date: string) {
        try {

            const allocations = await this.repository.fetchReports({
                date,
                reportsTypesIds: [REPORT_TYPES.ALLOCATION]
            });

            const allocationsItems = allocations.flatMap(allocation => (allocation.items ?? []).map(
                item => ({
                    ...item.dataValues,
                    status: RECORD_STATUS.INACTIVE
                }) as IReportItem
            ));

            return this.repository.updateReportsItems(allocationsItems);
        } catch (error) {
            throw new BadRequestException();
        }
    }
}
