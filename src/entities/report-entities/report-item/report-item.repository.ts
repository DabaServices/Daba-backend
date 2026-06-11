import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/sequelize";
import { Op, Transaction } from "sequelize";
import { REPORTABLE_OBJECT_TYPES } from "../../../constants";
import { Report } from "../report/report.model";
import { IReportItem, ReportItem } from "./report-item.model";
import { ReportItemKey } from "./report.types";
import { isNullish } from "remeda";

const reportableObjectTypesWhere = () => ({ [Op.in]: REPORTABLE_OBJECT_TYPES });

@Injectable()
export class ReportItemRepository {
    constructor(@InjectModel(Report) private readonly reportModel: typeof Report,
        @InjectModel(ReportItem) private readonly reportItemModel: typeof ReportItem) { }

    fetchReports(reportItemKey: ReportItemKey) {
        const reportWhereClause: any = {};
        const reportItemWhereClause: any = {};

        if(!isNullish(reportItemKey.materialId))
            reportWhereClause.materialId = reportItemKey.materialId;
        
        if(!isNullish(reportItemKey.recipientUnitId))
            reportItemWhereClause.recipientUnitId = reportItemKey.recipientUnitId;

        return this.reportModel.findAll({
            include: [{
                model: ReportItem,
                where: {
                    ...reportWhereClause,
                    reportingUnitObjectType: reportableObjectTypesWhere(),
                }
            }],
            where: {
                ...reportItemWhereClause,
                unitObjectType: reportableObjectTypesWhere(),
                recipientUnitObjectType: reportableObjectTypesWhere(),
                reporterUnitObjectType: reportableObjectTypesWhere(),
                reportTypeId: { [Op.in]: reportItemKey.reportsTypesIds },
                createdOn: reportItemKey.date
            }
        })
    }

    updateReportsItems(reportsItems: IReportItem[], transaction?: Transaction) {
        return this.reportItemModel.bulkCreate(reportsItems,
            {
                transaction,
                conflictAttributes: ["reportId", "materialId", "reportingLevel"],
                updateOnDuplicate: ['status', 'confirmedQuantity', 'reportedQuantity', 'balanceQuantity']
            }
        )
    }
}
